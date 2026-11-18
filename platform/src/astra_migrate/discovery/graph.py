"""The Migration Knowledge Graph (E08.F1.S1, E08.F3.S1).

Nodes follow the specification's model: id, stream, legacy element, usage, ontology concept and target
element. Edges carry from, to and the dependency type. The graph is built from one discovery run and
stored in the tenant's own database.

Streams (specification, "Migration streams"): data, configuration, customizations, integrations, reports,
users_security, process, agentification, platform.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

STREAMS = ["data", "configuration", "customizations", "integrations", "reports", "users_security", "process",
           "agentification", "platform"]
STREAM_TITLES = {"data": "Data and documents", "configuration": "Configuration", "customizations": "Customizations",
                 "integrations": "Integrations", "reports": "Reports and analytics",
                 "users_security": "Users, roles and security", "process": "Process and operating model",
                 "agentification": "Agentification", "platform": "Platform and hosting"}
TYPE_STREAM = {"table": "data", "user_defined_table": "customizations", "view": "reports",
               "procedure": "customizations",
               "function": "customizations", "trigger": "customizations", "security_profile": "users_security",
               "validation_rule": "configuration", "workflow": "configuration"}


@dataclass
class Node:
    id: str
    kind: str
    stream: str
    element: str
    usage: dict[str, Any] = field(default_factory=dict)
    concept: str | None = None
    target: str | None = None
    props: dict[str, Any] = field(default_factory=dict)


@dataclass
class Edge:
    src: str
    dst: str
    kind: str
    props: dict[str, Any] = field(default_factory=dict)


@dataclass
class Graph:
    nodes: dict[str, Node] = field(default_factory=dict)
    edges: list[Edge] = field(default_factory=list)

    def add(self, n: Node) -> Node:
        existing = self.nodes.get(n.id)
        if existing is None:
            self.nodes[n.id] = n
            return n
        existing.props.update(n.props)
        return existing

    def link(self, src: str, dst: str, kind: str, **props: Any) -> None:
        if src in self.nodes and dst in self.nodes:
            self.edges.append(Edge(src, dst, kind, props))

    def find(self, element: str) -> str | None:
        """The node for a named element: a table if one has that name, otherwise any node whose element
        name matches (views, procedures, functions, triggers)."""
        tid = table_id(element)
        if tid in self.nodes:
            return tid
        low = element.lower()
        for k in self.nodes:
            if k.split(":", 1)[-1] == low:
                return k
        return None

    def by_stream(self) -> dict[str, int]:
        out = dict.fromkeys(STREAMS, 0)
        for n in self.nodes.values():
            out[n.stream] = out.get(n.stream, 0) + 1
        return out


def table_id(name: str) -> str:
    return f"table:{name.lower()}"


def object_id(kind: str, name: str) -> str:
    return f"{kind}:{name.lower()}"
