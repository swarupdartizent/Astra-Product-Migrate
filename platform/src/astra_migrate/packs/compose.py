"""Pack composition (E04.F2.S1, CF-04, CF-05).

Pure and deterministic: the same pinned packs always compose to the same result.

- Controls and rules from every pack are unioned. Nothing can be removed.
- Settings set by more than one pack with different values are conflicts. The stricter value is
  shown when the setting defines an order, but it is never applied by default: a recorded decision
  by a person resolves each conflict.
- Customer overrides (from the blueprint) are classified as tightening or loosening against the
  effective value. Loosening needs a named approver and a reason.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any, Literal

from packaging.specifiers import SpecifierSet
from packaging.version import Version

from astra_migrate.packs.schema import PLACEMENT, Control, Manifest, Rule, Setting

Scalar = int | float | bool | str


@dataclass(frozen=True)
class PlacedControl:
    key: str  # "<pack>:<control id>" - unique across a composition
    pack: str  # pack ref name@version
    control: Control

    @property
    def placement(self) -> dict[str, str]:
        return PLACEMENT[self.control.type]


@dataclass(frozen=True)
class SettingValue:
    pack: str
    value: Scalar
    setting: Setting


@dataclass
class ComposedSetting:
    key: str
    stricter: str
    values: list[SettingValue]
    unit: str | None

    @property
    def distinct(self) -> list[Scalar]:
        seen: list[Scalar] = []
        for v in self.values:
            if v.value not in seen:
                seen.append(v.value)
        return seen

    @property
    def is_conflict(self) -> bool:
        return len(self.distinct) > 1

    @property
    def strictest(self) -> Scalar | None:
        """The stricter value, or None when the setting has no order."""
        vals = self.distinct
        match self.stricter:
            case "higher":
                return max(vals)
            case "lower":
                return min(vals)
            case "true":
                return True if True in vals else vals[0]
            case "false":
                return False if False in vals else vals[0]
            case _:
                return None if len(vals) > 1 else vals[0]

    @property
    def fingerprint(self) -> str:
        """Identifies this exact conflict, so a decision applies until the inputs change."""
        payload = json.dumps({"key": self.key, "values": sorted([[v.pack.split("@")[0], v.value]
                                                                 for v in self.values], key=str)},
                             sort_keys=True, default=str)
        return hashlib.sha256(payload.encode()).hexdigest()[:32]


@dataclass(frozen=True)
class Problem:
    severity: Literal["blocking", "warning"]
    code: str
    path: str
    message: str
    fix: str


@dataclass
class Composition:
    packs: list[str]
    controls: list[PlacedControl] = field(default_factory=list)
    rules: list[tuple[str, Rule]] = field(default_factory=list)
    settings: dict[str, ComposedSetting] = field(default_factory=dict)
    problems: list[Problem] = field(default_factory=list)

    @property
    def conflicts(self) -> list[ComposedSetting]:
        return [s for s in self.settings.values() if s.is_conflict]


def compare(stricter: str, a: Scalar, b: Scalar) -> int:
    """>0 when a is stricter than b, <0 when looser, 0 when equal or unordered-but-equal.
    For unordered settings any difference counts as looser (conservative)."""
    if a == b:
        return 0
    match stricter:
        case "higher":
            return 1 if float(a) > float(b) else -1
        case "lower":
            return 1 if float(a) < float(b) else -1
        case "true":
            return 1 if a is True else -1
        case "false":
            return 1 if a is False else -1
        case _:
            return -1


def compose(manifests: list[Manifest]) -> Composition:
    ordered = sorted(manifests, key=lambda m: (m.type.value, m.name))
    comp = Composition(packs=[m.ref for m in ordered])

    names: dict[str, Manifest] = {}
    for m in ordered:
        if m.name in names:
            comp.problems.append(Problem("blocking", "duplicate_pack", m.name,
                                         f"Pack '{m.name}' is pinned twice ({names[m.name].version} and {m.version}).",
                                         "Keep one version of each pack."))
        names[m.name] = m

    for m in ordered:
        for req in m.requires:
            have = names.get(req.name)
            if have is None:
                comp.problems.append(Problem(
                    "blocking", "missing_requirement", m.ref,
                    f"{m.ref} needs pack '{req.name}' ({req.versions}), which the blueprint does not include.",
                    f"Add {req.name} in a version matching {req.versions}."))
            elif Version(have.version) not in SpecifierSet(req.versions):
                comp.problems.append(Problem(
                    "blocking", "incompatible_version", m.ref,
                    f"{m.ref} needs {req.name} {req.versions}, but {have.ref} is pinned.",
                    f"Pin a version of {req.name} matching {req.versions}, or a version of {m.name} "
                    f"that accepts {have.version}."))

        for c in m.adds.controls:
            comp.controls.append(PlacedControl(f"{m.name}:{c.id}", m.ref, c))
        for r in m.adds.rules:
            comp.rules.append((m.ref, r))
        for s in m.adds.settings:
            cs = comp.settings.get(s.key)
            if cs is None:
                comp.settings[s.key] = ComposedSetting(s.key, s.stricter, [SettingValue(m.ref, s.value, s)], s.unit)
                continue
            if cs.stricter != s.stricter or cs.unit != s.unit:
                comp.problems.append(Problem(
                    "blocking", "setting_definition_mismatch", s.key,
                    f"Packs define setting '{s.key}' differently (strictness or unit): "
                    f"{cs.values[0].pack} vs {m.ref}.",
                    "Ask the pack curators to align the setting definition."))
            cs.values.append(SettingValue(m.ref, s.value, s))
    return comp


@dataclass(frozen=True)
class OverrideCheck:
    key: str
    value: Scalar
    effective: Scalar | None
    direction: Literal["tighten", "loosen", "same", "new"]


def classify_override(comp: Composition, key: str, value: Scalar, decided: dict[str, Scalar]) -> OverrideCheck:
    cs = comp.settings.get(key)
    if cs is None:
        return OverrideCheck(key, value, None, "new")
    effective = decided.get(key) if cs.is_conflict else cs.distinct[0]
    if effective is None:
        effective = cs.strictest
    if effective is None:
        return OverrideCheck(key, value, None, "loosen")
    c = compare(cs.stricter, value, effective)
    return OverrideCheck(key, value, effective, "same" if c == 0 else ("tighten" if c > 0 else "loosen"))


def to_json(comp: Composition) -> dict[str, Any]:
    return {
        "packs": comp.packs,
        "controls": [{"key": pc.key, "pack": pc.pack, "id": pc.control.id, "type": pc.control.type.value,
                      "title": pc.control.title, "rule": pc.control.rule,
                      "evidence_required": pc.control.evidence_required, "gate": pc.control.gate,
                      "compliance_critical": pc.control.compliance_critical,
                      "two_person_approval": pc.control.two_person_approval,
                      "parameters": pc.control.parameters, "placement": pc.placement,
                      "sources": [s.model_dump() for s in pc.control.sources]} for pc in comp.controls],
        "rules": [{"pack": p, **r.model_dump()} for p, r in comp.rules],
        "settings": [{"key": s.key, "stricter": s.stricter, "unit": s.unit, "conflict": s.is_conflict,
                      "strictest": s.strictest, "fingerprint": s.fingerprint,
                      "values": [{"pack": v.pack, "value": v.value} for v in s.values]}
                     for s in sorted(comp.settings.values(), key=lambda x: x.key)],
        "problems": [p.__dict__ for p in comp.problems],
    }
