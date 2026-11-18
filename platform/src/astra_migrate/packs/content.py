"""Type-specific validation of a pack's `content` (adapter contract, ontology)."""

from __future__ import annotations

import yaml
from pydantic import ValidationError

from astra_migrate.adapters.contract import parse_source, parse_target
from astra_migrate.ontology.model import DomainContent
from astra_migrate.packs.schema import Manifest, PackType


def _errs(prefix: str, e: ValidationError) -> list[dict[str, str]]:
    return [{"field": prefix + "." + ".".join(str(x) for x in err["loc"]) if err["loc"] else prefix,
             "message": err["msg"].removeprefix("Value error, ")} for err in e.errors()]


def content_problems(m: Manifest, files: dict[str, bytes]) -> list[dict[str, str]]:
    try:
        if m.type == PackType.SOURCE_ADAPTER:
            src = parse_source(m.content)
            out: list[dict[str, str]] = []
            for g in src.golden_datasets:
                desc = f"{g.path.rstrip('/')}/dataset.yaml"
                if desc not in files:
                    out.append({"field": f"content.golden_datasets.{g.name}", "message": f"{desc} is not in the pack"})
                    continue
                try:
                    raw = yaml.safe_load(files[desc])
                except yaml.YAMLError as e:
                    out.append({"field": desc, "message": f"not valid YAML: {e}"})
                    continue
                raw = raw or {}
                listed = [*raw.get("build", []), raw.get("expected", ""), raw.get("delta", ""),
                          raw.get("activity", "")]
                for f in listed:
                    if f and f"{g.path.rstrip('/')}/{f}" not in files:
                        out.append({"field": desc, "message": f"{f} is listed but not in the pack"})
            return out
        if m.type == PackType.TARGET_ADAPTER:
            parse_target(m.content)
        elif m.type == PackType.DOMAIN and "ontology" in m.content:
            DomainContent.model_validate(m.content)
    except ValidationError as e:
        return _errs("content", e)
    return []
