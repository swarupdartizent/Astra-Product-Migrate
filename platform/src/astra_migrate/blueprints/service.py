"""Blueprint versions, validation, comparison, decisions and approval.

Stories: CF-01 E03.F1.S1/S2, CF-03 E03.F2.S1, CF-04 E03.F2.S2, CF-05 E03.F2.S3, E03.F2.S4,
E04.F1.S2 (pack upgrades are new blueprint versions that need approval), E01.F1.S2 (residency).
"""

from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

import yaml
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from astra_migrate import audit
from astra_migrate.blueprints import repo
from astra_migrate.blueprints.model import Blueprint
from astra_migrate.db.models import (
    BlueprintApproval,
    BlueprintVersion,
    ConnectorSecret,
    Decision,
    Project,
    Tenant,
    User,
)
from astra_migrate.packs.compose import Composition, classify_override, compare, compose, to_json
from astra_migrate.packs.registry import get_by_ref, manifest_of
from astra_migrate.packs.schema import ControlType, Manifest
from astra_migrate.security.rbac import ROLES
from astra_migrate.tenancy.regions import get_region, model_endpoint_is_in_region

Severity = Literal["blocking", "warning"]


class BlueprintError(ValueError):
    pass


@dataclass
class Issue:
    severity: Severity
    code: str
    path: str
    message: str
    fix: str


@dataclass
class Validation:
    issues: list[Issue] = field(default_factory=list)
    composition: dict[str, Any] | None = None
    open_decisions: list[dict[str, Any]] = field(default_factory=list)
    blueprint: Blueprint | None = None

    @property
    def blocking(self) -> list[Issue]:
        return [i for i in self.issues if i.severity == "blocking"]

    def add(self, severity: Severity, code: str, path: str, message: str, fix: str) -> None:
        self.issues.append(Issue(severity, code, path, message, fix))

    def to_json(self) -> dict[str, Any]:
        return {"ok": not self.blocking, "blocking": len(self.blocking),
                "warnings": len(self.issues) - len(self.blocking), "issues": [asdict(i) for i in self.issues],
                "composition": self.composition, "open_decisions": self.open_decisions}


# --------------------------------------------------------------------------- parsing

def parse_yaml(text: str) -> dict[str, Any]:
    try:
        raw = yaml.safe_load(text)
    except yaml.YAMLError as e:
        mark = getattr(e, "problem_mark", None)
        where = f" (line {mark.line + 1}, column {mark.column + 1})" if mark else ""
        raise BlueprintError(f"The file is not valid YAML{where}: {getattr(e, 'problem', e)}") from e
    if not isinstance(raw, dict):
        raise BlueprintError("A blueprint must be a YAML mapping at the top level.")
    return raw


def to_yaml(content: dict[str, Any]) -> str:
    """Canonical YAML used when the form saves, so form and file stay in sync."""
    return yaml.safe_dump(content, sort_keys=False, allow_unicode=True, default_flow_style=False, width=100)


_FIXES = {
    "missing": "Add this field.",
    "extra_forbidden": "Remove this field, or check its spelling.",
    "literal_error": "Choose one of the allowed values.",
    "string_pattern_mismatch": "Use lowercase letters, digits and hyphens.",
}


def _schema_issues(e: ValidationError) -> list[Issue]:
    out = []
    for err in e.errors():
        path = ".".join(str(p) for p in err["loc"]) or "(root)"
        msg = err["msg"].removeprefix("Value error, ")
        fix = _FIXES.get(err["type"], "Correct this value.")
        out.append(Issue("blocking", f"schema.{err['type']}", path, msg, fix))
    return out


# --------------------------------------------------------------------------- decisions

def _decision_fp(kind: str, payload: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps({"kind": kind, **payload}, sort_keys=True, default=str).encode()).hexdigest()[:32]


def _upsert_open(session: Session, project: Project, kind: str, fp: str, subject: str, ctx: dict[str, Any],
                 requested_by: uuid.UUID | None) -> Decision:
    d = session.scalar(select(Decision).where(Decision.project_id == project.id, Decision.kind == kind,
                                              Decision.fingerprint == fp))
    if d is None:
        d = Decision(tenant_id=project.tenant_id, project_id=project.id, kind=kind, fingerprint=fp, subject=subject,
                     context=ctx, status="open", requested_by=requested_by)
        session.add(d)
        session.flush()
    return d


def _decision_json(d: Decision) -> dict[str, Any]:
    return {"id": str(d.id), "kind": d.kind, "subject": d.subject, "status": d.status, "context": d.context}


# --------------------------------------------------------------------------- validation

def validate(session: Session, tenant: Tenant, project: Project, content: dict[str, Any], *,
             record_decisions: bool = False, actor_id: uuid.UUID | None = None) -> Validation:
    v = Validation()
    try:
        bp = Blueprint.model_validate(content)
    except ValidationError as e:
        v.issues += _schema_issues(e)
        return v
    v.blueprint = bp

    # 1. Packs exist, are published and sit in the right slot.
    manifests: list[Manifest] = []
    for path, ref, kind in bp.pack_slots():
        p = get_by_ref(session, ref)
        if p is None:
            v.add("blocking", "pack.not_published", path, f"Pack {ref} is not published in the registry.",
                  "Pick a published version from the pack library.")
            continue
        if p.type != kind:
            v.add("blocking", "pack.wrong_type", path, f"{ref} is a {p.type.replace('_', ' ')} pack, "
                  f"but this slot needs a {kind.replace('_', ' ')} pack.", "Move it to the right section.")
        if p.status == "deprecated":
            v.add("warning", "pack.deprecated", path, f"{ref} is deprecated.", "Plan an upgrade to a newer version.")
        manifests.append(manifest_of(p))

    # 2. Compose: requirements, conflicts.
    comp: Composition = compose(manifests)
    v.composition = to_json(comp)
    for prob in comp.problems:
        v.add(prob.severity, f"compose.{prob.code}", prob.path, prob.message, prob.fix)

    decided_values: dict[str, Any] = {}
    for cs in comp.conflicts:
        fp = cs.fingerprint
        d = session.scalar(select(Decision).where(Decision.project_id == project.id,
                                                  Decision.kind == "setting_conflict", Decision.fingerprint == fp))
        if d is not None and d.status == "decided" and d.chosen_value is not None:
            decided_values[cs.key] = d.chosen_value["value"]
            continue
        ctx = {"key": cs.key, "stricter": cs.stricter, "unit": cs.unit, "strictest": cs.strictest,
               "values": [{"pack": x.pack, "value": x.value, "description": x.setting.description,
                           "sources": [s.model_dump() for s in x.setting.sources]} for x in cs.values]}
        if record_decisions:
            d = _upsert_open(session, project, "setting_conflict", fp, cs.key, ctx, actor_id)
            v.open_decisions.append(_decision_json(d))
        shown = f" The stricter value is {cs.strictest}." if cs.strictest is not None else ""
        v.add("blocking", "conflict.undecided", f"settings.{cs.key}",
              f"Packs set '{cs.key}' differently: " + ", ".join(f"{x.pack} = {x.value}" for x in cs.values) + "."
              + shown + " No default is applied.",
              "A compliance curator or migration lead must decide this conflict and record a reason.")

    # 3. Customer overrides: tightening is free; loosening needs a named approver and a reason.
    for i, o in enumerate(bp.overrides):
        chk = classify_override(comp, o.setting, o.value, decided_values)
        path = f"overrides[{i}]"
        if chk.direction == "new":
            v.add("warning", "override.unknown_setting", path,
                  f"No selected pack defines '{o.setting}', so this override has no effect.",
                  "Check the setting name against the packs' settings.")
        elif chk.direction == "loosen":
            payload = {"setting": o.setting, "value": o.value, "effective": chk.effective}
            fp = _decision_fp("loosening", payload)
            d = session.scalar(select(Decision).where(Decision.project_id == project.id, Decision.kind == "loosening",
                                                      Decision.fingerprint == fp))
            if d is not None and d.status == "decided":
                continue
            if record_decisions:
                d = _upsert_open(session, project, "loosening", fp, o.setting,
                                 {**payload, "reason": o.reason,
                                  "packs": [x.pack for x in comp.settings[o.setting].values]},
                                 actor_id)
                v.open_decisions.append(_decision_json(d))
            status = " It was rejected." if d is not None and d.status == "rejected" else ""
            v.add("blocking", "override.loosening_unapproved", path,
                  f"Setting '{o.setting}' to {o.value} loosens the packs' value ({chk.effective}).{status}",
                  "A named approver must approve this loosening with a reason, or tighten the value.")

    # 4. Residency controls against the tenant's region (E01.F1.S2).
    region = get_region(tenant.region_code)
    for pc in comp.controls:
        if pc.control.type != ControlType.RESIDENCY:
            continue
        allowed = pc.control.parameters.get("allowed_jurisdictions")
        if allowed and region.jurisdiction not in allowed:
            v.add("blocking", "residency.region", "tenant.region",
                  f"Control {pc.key} allows data only in {', '.join(allowed)}, but this tenant is hosted in "
                  f"{region.name} ({region.jurisdiction}).",
                  "Move the tenant to a compliant region through a region migration, or change the compliance packs.")
        if pc.control.parameters.get("model_calls_in_region"):
            pinned = [p for p in region.model_endpoints if model_endpoint_is_in_region(region, p)]
            if not pinned:
                v.add("blocking", "residency.model_endpoint", "tenant.region",
                      f"Control {pc.key} requires model calls to stay in the region, but no model provider "
                      f"offers an endpoint pinned to {region.name}.",
                      "Configure a regional model endpoint for this region.")

    # 5. Connections refer to secrets that exist in this tenant.
    for path, conn in (("source.connection", bp.source.connection), ("target.connection", bp.target.connection)):
        if conn:
            name = conn.removeprefix("secret://")
            if session.scalar(select(ConnectorSecret).where(ConnectorSecret.tenant_id == tenant.id,
                                                            ConnectorSecret.name == name)) is None:
                v.add("warning", "connection.missing_secret", path, f"No secret named '{name}' exists in this tenant.",
                      "Add it on the tenant's Connector secrets tab before discovery starts.")

    # 6. Approval roles exist.
    for stage in ("blueprint", "plan", "cutover"):
        for i, role in enumerate(getattr(bp.approvals, stage)):
            if role not in ROLES:
                v.add("blocking", "approvals.unknown_role", f"approvals.{stage}[{i}]", f"'{role}' is not a role.",
                      "Use a role from the access catalogue, such as migration_lead.")
    if len(set(bp.approvals.blueprint)) != len(bp.approvals.blueprint):
        v.add("blocking", "approvals.duplicate", "approvals.blueprint", "A role is listed twice.", "List each once.")
    return v


# --------------------------------------------------------------------------- saving and reading

def latest(session: Session, project_id: uuid.UUID) -> BlueprintVersion | None:
    return session.scalar(select(BlueprintVersion).where(BlueprintVersion.project_id == project_id)
                          .order_by(BlueprintVersion.number.desc()).limit(1))


def save_version(session: Session, tenant: Tenant, project: Project, text: str, message: str, author: User,
                 actor: audit.Actor, template: str | None = None) -> tuple[BlueprintVersion, Validation]:
    if len(message.strip()) < 5:
        raise BlueprintError("Say why you are saving this version (at least 5 characters).")
    content = parse_yaml(text)
    prev = latest(session, project.id)
    if prev is not None and prev.yaml_text == text:
        raise BlueprintError(f"Nothing changed since version {prev.number}.")
    sha = repo.commit_blueprint(tenant.id, project.id, text, author.display_name, author.email, message.strip())
    number = (session.scalar(select(func.max(BlueprintVersion.number))
                             .where(BlueprintVersion.project_id == project.id)) or 0) + 1
    bv = BlueprintVersion(project_id=project.id, number=number, yaml_text=text, content=content, commit_sha=sha,
                          message=message.strip(), template=template, author_id=author.id, status="draft")
    session.add(bv)
    for old in session.scalars(select(BlueprintVersion).where(BlueprintVersion.project_id == project.id,
                                                              BlueprintVersion.status == "draft",
                                                              BlueprintVersion.number < number)):
        old.status = "superseded"
    session.flush()
    v = validate(session, tenant, project, content, record_decisions=True, actor_id=author.id)
    audit.record(session, actor, "blueprint.version_saved", tenant_id=tenant.id, project_id=project.id,
                 target_type="blueprint_version", target_id=str(bv.id),
                 details={"number": number, "commit": sha, "message": bv.message, "template": template,
                          "blocking_issues": len(v.blocking)})
    return bv, v


# --------------------------------------------------------------------------- comparing

def _flatten(obj: Any, prefix: str = "") -> dict[str, Any]:
    out: dict[str, Any] = {}
    if isinstance(obj, dict):
        for k, val in obj.items():
            out.update(_flatten(val, f"{prefix}.{k}" if prefix else str(k)))
    elif isinstance(obj, list) and obj and all(isinstance(x, str | int | float | bool) for x in obj):
        for x in obj:  # scalar lists compare as sets (pack lists, role lists)
            out[f"{prefix}[{x}]"] = True
    elif isinstance(obj, list):
        for i, x in enumerate(obj):
            out.update(_flatten(x, f"{prefix}[{i}]"))
    else:
        out[prefix] = obj
    return out


def diff(a: dict[str, Any], b: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    fa, fb = _flatten(a), _flatten(b)
    return {
        "added": [{"path": k, "value": fb[k]} for k in sorted(fb.keys() - fa.keys())],
        "removed": [{"path": k, "value": fa[k]} for k in sorted(fa.keys() - fb.keys())],
        "changed": [{"path": k, "before": fa[k], "after": fb[k]} for k in sorted(fa.keys() & fb.keys())
                    if fa[k] != fb[k]],
    }


# --------------------------------------------------------------------------- decisions

def decide(session: Session, d: Decision, actor: audit.Actor, user: User, *, approve: bool, reason: str,
           chosen_value: Any = None) -> Decision:
    if d.status != "open":
        raise BlueprintError("This decision has already been made.")
    if len(reason.strip()) < 10:
        raise BlueprintError("Give a reason of at least 10 characters.")
    details: dict[str, Any] = {"kind": d.kind, "subject": d.subject, "reason": reason.strip()}
    if d.kind == "setting_conflict":
        values = [x["value"] for x in d.context["values"]]
        if chosen_value not in values:
            raise BlueprintError("Choose one of the values the packs set.")
        strictest = d.context.get("strictest")
        loosening = strictest is not None and compare(d.context["stricter"], chosen_value, strictest) < 0
        if loosening and d.requested_by == user.id:
            raise BlueprintError("Choosing the less strict value needs a different person from the one who "
                                 "raised the conflict.")
        d.status, d.chosen_value = "decided", {"value": chosen_value}
        details |= {"chosen": chosen_value, "strictest": strictest, "loosening": loosening}
    else:  # loosening approval (CF-05): named approver, never the requester
        if d.requested_by == user.id:
            raise BlueprintError("A loosening must be approved by someone other than the person who requested it.")
        d.status = "decided" if approve else "rejected"
        details |= {"approved": approve, "value": d.context.get("value"), "effective": d.context.get("effective")}
    d.reason, d.decided_by, d.decided_at = reason.strip(), user.id, datetime.now(UTC)
    audit.record(session, actor, f"decision.{d.kind}", tenant_id=d.tenant_id, project_id=d.project_id,
                 target_type="decision", target_id=str(d.id), details=details)
    return d


# --------------------------------------------------------------------------- approval

def approve_or_reject(session: Session, tenant: Tenant, project: Project, bv: BlueprintVersion, user: User,
                      user_roles: set[str], actor: audit.Actor, *, approve: bool, reason: str
                      ) -> BlueprintVersion:
    if actor.type != "user":
        raise BlueprintError("Only people can approve blueprints.")
    current = latest(session, project.id)
    if current is None or current.id != bv.id:
        raise BlueprintError("Only the latest version can be approved.")
    if bv.status not in ("draft",):
        raise BlueprintError(f"Version {bv.number} is {bv.status}.")
    bp_roles = (bv.content.get("approvals") or {}).get("blueprint") or ["migration_lead", "customer_data_owner"]
    given = {a.role for a in session.scalars(select(BlueprintApproval).where(
        BlueprintApproval.version_id == bv.id, BlueprintApproval.decision == "approve"))}
    mine = session.scalar(select(BlueprintApproval).where(BlueprintApproval.version_id == bv.id,
                                                          BlueprintApproval.user_id == user.id))
    if mine is not None:
        raise BlueprintError("You have already recorded your decision on this version.")
    eligible = [r for r in bp_roles if r in user_roles and r not in given]
    if not eligible:
        raise BlueprintError("You do not hold an approver role this version still needs: "
                             + ", ".join(r for r in bp_roles if r not in given))
    if not approve:
        if len(reason.strip()) < 10:
            raise BlueprintError("Give a reason of at least 10 characters when rejecting.")
        session.add(BlueprintApproval(version_id=bv.id, user_id=user.id, role=eligible[0], decision="reject",
                                      reason=reason.strip()))
        bv.status = "rejected"
        audit.record(session, actor, "blueprint.rejected", tenant_id=tenant.id, project_id=project.id,
                     target_type="blueprint_version", target_id=str(bv.id),
                     details={"number": bv.number, "role": eligible[0], "reason": reason.strip()})
        return bv
    v = validate(session, tenant, project, bv.content)
    if v.blocking:
        raise BlueprintError(f"Version {bv.number} has {len(v.blocking)} blocking problem(s). Fix them first.")
    role = eligible[0]
    session.add(BlueprintApproval(version_id=bv.id, user_id=user.id, role=role, decision="approve",
                                  reason=reason.strip()))
    session.flush()
    given.add(role)
    audit.record(session, actor, "blueprint.approval_given", tenant_id=tenant.id, project_id=project.id,
                 target_type="blueprint_version", target_id=str(bv.id),
                 details={"number": bv.number, "role": role, "remaining": [r for r in bp_roles if r not in given]})
    if all(r in given for r in bp_roles):
        for old in session.scalars(select(BlueprintVersion).where(BlueprintVersion.project_id == project.id,
                                                                  BlueprintVersion.status == "approved")):
            old.status = "superseded"
        session.flush()
        bv.status, bv.approved_at = "approved", datetime.now(UTC)
        audit.record(session, actor, "blueprint.approved", tenant_id=tenant.id, project_id=project.id,
                     target_type="blueprint_version", target_id=str(bv.id),
                     details={"number": bv.number, "commit": bv.commit_sha,
                              "packs": (v.composition or {}).get("packs", [])})
    return bv


def planning_gate(session: Session, tenant: Tenant, project: Project) -> dict[str, Any]:
    """Planning may start only from an approved blueprint with no blocking problems (E03.F2.S1)."""
    approved = session.scalar(select(BlueprintVersion).where(BlueprintVersion.project_id == project.id,
                                                             BlueprintVersion.status == "approved"))
    if approved is None:
        return {"ready": False, "reason": "No approved blueprint version yet.", "version": None}
    v = validate(session, tenant, project, approved.content)
    if v.blocking:
        return {"ready": False, "version": approved.number,
                "reason": f"The approved version now has {len(v.blocking)} blocking problem(s)."}
    return {"ready": True, "version": approved.number, "reason": "Approved and valid."}
