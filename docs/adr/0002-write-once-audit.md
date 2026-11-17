# ADR 0002: Write-once audit log

Status: accepted (17 Nov 2026) · Stories: E01.F3.S1 (RG-03)

## Context
Every person and agent action must be recorded in a log that no user, including administrators, can change or
delete, and tampering must be detectable.

## Decision
Three layers, each covering what the one before cannot:

1. **Privileges.** The runtime role has only `SELECT` and `INSERT` on `audit_events` and `audit_anchors`.
2. **Triggers.** `UPDATE`, `DELETE` and `TRUNCATE` raise an error for every role, including the database superuser
   acting through SQL. A `BEFORE INSERT` trigger assigns the sequence number, the server timestamp, the previous hash
   and the SHA-256 hash, so callers cannot forge them. `audit_hash()` is the single definition of the hash.
3. **Signed anchors.** Verification recomputes every hash and then signs the chain head with an Ed25519 key held in
   the key service. Someone with full database control (who could disable triggers and rewrite the chain) cannot
   produce a valid signature, so a rewrite before an anchor is detected.

Appends are serialised with a transaction-level advisory lock so the chain stays linear.

## Consequences
- Platform administrators cannot alter history. Infrastructure superusers can, but not undetectably once an anchor
  exists. In Azure, anchors and periodic exports also go to immutable (WORM) Blob storage.
- The advisory lock serialises audit writes. This is fine at current volumes; if it becomes a bottleneck, switch to
  per-partition chains with a combined anchor.
