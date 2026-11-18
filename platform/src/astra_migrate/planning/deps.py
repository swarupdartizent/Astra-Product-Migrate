"""Dependency graph across all streams (E11.F1.S2).

Edges come from the knowledge graph (code depending on tables, foreign keys, interfaces reading or writing
elements) between elements in scope, plus edges people add. People can also remove a generated edge; the removal is
kept, with who and why, so a re-generation does not bring it back. `src -> dst` means src's work comes after dst's.
Cycles are errors: work cannot be ordered until someone breaks them.
"""

from __future__ import annotations

from typing import Any

ORDERING_EDGES = {"depends_on": "depends on", "references": "references", "reads": "reads",
                  "writes": "writes", "executes": "executes"}


def generated(kg_edges: list[tuple[str, str, str]], scope_keys: set[str]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for src, dst, kind in kg_edges:
        if kind not in ORDERING_EDGES or src == dst or src not in scope_keys or dst not in scope_keys:
            continue
        out.setdefault(f"{src}->{dst}", {"src": src, "dst": dst, "kinds": [], "source": "discovery",
                                          "removed": None})["kinds"].append(kind)
    for e in out.values():
        e["kinds"] = sorted(set(e["kinds"]))
    return out


def merge(fresh: dict[str, dict[str, Any]], existing: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Keep people's edges and removals; refresh generated edges."""
    out = dict(fresh)
    for k, e in existing.items():
        if e.get("source") == "person":
            out[k] = e
        elif e.get("removed") and k in out:
            out[k] = {**out[k], "removed": e["removed"]}
    return out


def active(edges: dict[str, dict[str, Any]]) -> list[tuple[str, str]]:
    return sorted((e["src"], e["dst"]) for e in edges.values() if not e.get("removed"))


def cycles(nodes: set[str], edges: list[tuple[str, str]]) -> list[list[str]]:
    """Strongly connected components with more than one element (Tarjan, iterative)."""
    adj: dict[str, list[str]] = {n: [] for n in nodes}
    for s, d in edges:
        if s in adj and d in adj:
            adj[s].append(d)
    index: dict[str, int] = {}
    low: dict[str, int] = {}
    on: set[str] = set()
    stack: list[str] = []
    out: list[list[str]] = []
    counter = 0
    for root in sorted(nodes):
        if root in index:
            continue
        work: list[tuple[str, int]] = [(root, 0)]
        while work:
            v, i = work.pop()
            if i == 0:
                index[v] = low[v] = counter
                counter += 1
                stack.append(v)
                on.add(v)
            recurse = False
            for j in range(i, len(adj[v])):
                w = adj[v][j]
                if w not in index:
                    work.append((v, j + 1))
                    work.append((w, 0))
                    recurse = True
                    break
                if w in on:
                    low[v] = min(low[v], index[w])
            if recurse:
                continue
            if low[v] == index[v]:
                comp = []
                while True:
                    w = stack.pop()
                    on.discard(w)
                    comp.append(w)
                    if w == v:
                        break
                if len(comp) > 1:
                    out.append(sorted(comp))
            if work:
                parent = work[-1][0]
                low[parent] = min(low[parent], low[v])
    return sorted(out)


def order(nodes: set[str], edges: list[tuple[str, str]]) -> dict[str, int]:
    """Depth of each node (0 = no dependencies); nodes in cycles share their component's depth."""
    comp_of = {n: n for n in nodes}
    for cyc in cycles(nodes, edges):
        for n in cyc:
            comp_of[n] = cyc[0]
    comps = set(comp_of.values())
    after: dict[str, set[str]] = {c: set() for c in comps}  # dependency -> dependents
    indeg = dict.fromkeys(comps, 0)
    for s, d in edges:
        if s not in comp_of or d not in comp_of:
            continue
        cs, cd = comp_of[s], comp_of[d]
        if cs != cd and cs not in after[cd]:
            after[cd].add(cs)
            indeg[cs] += 1
    depth = dict.fromkeys(comps, 0)
    ready = sorted(c for c in comps if indeg[c] == 0)
    while ready:
        c = ready.pop()
        for nxt in after[c]:
            depth[nxt] = max(depth[nxt], depth[c] + 1)
            indeg[nxt] -= 1
            if indeg[nxt] == 0:
                ready.append(nxt)
    return {n: depth[comp_of[n]] for n in nodes}
