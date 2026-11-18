"""Text embeddings for the ontology's vector index.

The default embedder is lexical: a signed feature-hashing vectoriser over normalised words, word pairs
and character trigrams, L2-normalised, 384 dimensions. It is deterministic, needs no model download
and no external call, and works well for finding concepts by label, synonym and definition wording,
including partial words and abbreviations ("prem split", "finco"). It does not understand meaning
beyond shared wording; a model-based embedder can replace it behind the same interface, and the
vectors are re-indexed with the embedder's name stored next to them.
"""

from __future__ import annotations

import hashlib
import itertools
import math
import re

DIM = 384
NAME = "lexical-hash-v1"
_STOP = {"a", "an", "the", "of", "and", "or", "to", "in", "on", "for", "by", "with", "is", "are", "be", "that",
         "this", "it", "as", "at", "from", "which", "its", "can", "each", "one", "any"}


def tokens(text: str) -> list[str]:
    words = re.findall(r"[a-z0-9]+", text.lower().replace("_", " "))
    return [w for w in words if w not in _STOP]


def _h(feature: str) -> tuple[int, float]:
    d = hashlib.blake2b(feature.encode(), digest_size=8).digest()
    n = int.from_bytes(d, "big")
    return n % DIM, (1.0 if (n >> 63) & 1 else -1.0)


def embed(text: str) -> list[float]:
    vec = [0.0] * DIM
    words = tokens(text)
    feats: list[tuple[str, float]] = [(f"w:{w}", 1.0) for w in words]
    feats += [(f"b:{a}_{b}", 0.7) for a, b in itertools.pairwise(words)]
    for w in words:
        padded = f"^{w}$"
        feats += [(f"c:{padded[i:i + 3]}", 0.35) for i in range(len(padded) - 2)]
    for f, weight in feats:
        i, sign = _h(f)
        vec[i] += sign * weight
    norm = math.sqrt(sum(v * v for v in vec))
    return [v / norm for v in vec] if norm else vec


def literal(vec: list[float]) -> str:
    return "[" + ",".join(f"{v:.6f}" for v in vec) + "]"
