"""Structured JSON logging with secret redaction.

Every secret the process handles is registered with `register_secret`; the redaction filter
replaces any registered value (and common credential patterns) before a record is emitted.
The test suite scans captured logs for secret values (E01.F2.S3).
"""

from __future__ import annotations

import json
import logging
import re
import sys
import threading
from datetime import UTC, datetime
from typing import Any

_lock = threading.Lock()
_secrets: set[str] = set()
_PATTERNS = [
    re.compile(r"(?i)(password|passwd|pwd|secret|token|api[_-]?key)(\s*[=:]\s*)([^\s,;&'\"]+)"),
    re.compile(r"(?i)(postgresql(?:\+\w+)?://[^:/\s]+:)([^@\s]+)(@)"),
    re.compile(r"(?i)(bearer\s+)([a-z0-9._\-]+)"),
]
REDACTED = "[REDACTED]"


def register_secret(value: str | None) -> None:
    if value and len(value) >= 6:
        with _lock:
            _secrets.add(value)


def redact(text: str) -> str:
    with _lock:
        values = sorted(_secrets, key=len, reverse=True)
    for v in values:
        if v in text:
            text = text.replace(v, REDACTED)
    text = _PATTERNS[0].sub(lambda m: f"{m.group(1)}{m.group(2)}{REDACTED}", text)
    text = _PATTERNS[1].sub(lambda m: f"{m.group(1)}{REDACTED}{m.group(3)}", text)
    text = _PATTERNS[2].sub(lambda m: f"{m.group(1)}{REDACTED}", text)
    return text


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        for key in ("trace_id", "span_id", "tenant_id", "actor"):
            if hasattr(record, key):
                payload[key] = getattr(record, key)
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return redact(json.dumps(payload, default=str))


def configure_logging(level: str = "INFO") -> None:
    root = logging.getLogger()
    if any(isinstance(h.formatter, JsonFormatter) for h in root.handlers):
        return
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root.handlers = [handler]
    root.setLevel(level)
    for noisy in ("uvicorn.access",):
        logging.getLogger(noisy).setLevel(logging.WARNING)
