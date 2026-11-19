# ADR 0011: Gate checklists from records, and proof packs signed with the vault key

Status: accepted (I11, 19 Nov 2026)

## Context

I11 covers lifecycle gates with checklists (E17.F1.S1) and the auditor's proof pack (E17.F2.S1). Stages for
execution, validation and cutover had no evidence check until now. Compliance packs already name a lifecycle gate on
their controls. The audit trail is anchored with a vault-held Ed25519 key.

## Decision

1. **Checklists are computed, not typed.** Evidence items are read from the platform's records every time and link
   to them. Only what no record can prove (a compliance control's evidence, decommissioning) is attested by a person,
   with a note and a reference.
2. **Compliance packs add gate conditions through their controls' `gate`**, so a new pack changes the checklists
   without code.
3. **Approvals bind to the checklist digest.** A pass needs one approval per required role, from different people,
   on exactly that digest. The database enforces it, so evidence that changes after approval cannot ride on old
   approvals.
4. **Gates are the stage evidence** for execution (design), validation (build and rehearse) and cutover (cutover).
5. **A proof pack is canonical JSON plus a PDF rendered from it, signed together.** The signature covers both
   digests with the vault key, under the existing `platform-*` key policy. The public key is published for offline
   verification. The content stays in the tenant; the control plane keeps digests and the signature, and refuses
   changes.

## Consequences

Auditors get a self-contained, verifiable pack where every item points to its record. The signature is a detached
Ed25519 signature, not a PAdES signature shown by PDF readers; that needs an organisation certificate (recorded as a
gap). Gate labels such as G0 to G4 come from the blueprint, so the platform stays generic.
