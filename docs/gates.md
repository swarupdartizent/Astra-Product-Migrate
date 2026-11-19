# Gates and proof packs (I11)

## Gates (E17.F1.S1)

`GET /api/v1/projects/{id}/gates` returns the eight lifecycle gates with their checklists. The gates are configure,
discover, plan, design, build and rehearse, cutover, stabilise and decommission; compliance-pack controls use the
same names.

Each checklist has three kinds of item:

| Kind | Met when | Example |
|---|---|---|
| `evidence` | the platform's own records show it; the item links to the record | blueprint approved; discovery coverage accepted; plan baseline approved; every mapping decided; transformation code approved; a reconciled rehearsal; a final load; every break closed; parity passed; documents verified; cutover approach chosen; no open coexistence breaks |
| `control` | a person attests it with evidence (`PUT /gates/{gate}/evidence {item_key, note, reference}`) | every control of the blueprint's compliance packs whose `gate` is this one; controls without a gate use their type's default gates |
| `attestation` | a person attests it | decommissioning (legacy access removed and data retained or destroyed by policy) and closing hypercare |

**Approval.**
- `POST /gates/{gate}/approvals {role, note}` records one approval for one of your roles, on the checklist as it is
  now (its digest). Only a complete checklist can be approved.
- A gate passes when every required role has approved, each by a different person.
- If the checklist changes afterwards, the gate shows `changed_since_pass` and earlier approvals do not count for
  the new checklist.
- The database refuses a pass without an approval from every role on exactly that digest. It also refuses
  approvals and attestations recorded by an agent.

**Labels and approvers.** By default a gate is approved by the migration lead and the customer data owner, and the
cutover gate also by the blueprint's `approvals.cutover` roles. The blueprint's `gates` list relabels gates (for
example G0 to G4 in the reference programme) and sets their approver roles.

**Stages.** Passing gates is the evidence the later stages need:

| Stage | Gate that must have passed |
|---|---|
| execution | design |
| validation | build and rehearse |
| cutover | cutover |

## Proof packs (E17.F2.S1)

`POST /api/v1/projects/{id}/proof-packs {wave?}` produces a numbered proof pack for the whole project, or for one
wave (scope items assigned to it and their lineage).

The pack is canonical JSON (`astra.proofpack/v1`) plus a PDF rendered from it. It has these sections:

- **Configuration:** the approved blueprint version and its approvers, every pinned pack, and the source and target
  adapters.
- **Scope:** every scope item with its disposition and decision.
- **Lineage:** source table to target table, with the approved mappings and who decided them, the code version and
  digest with its test results, and the load runs and accepted counts.
- **Decisions:**
  - review items with outcome, decider and note;
  - conflict and loosening decisions;
  - plan baseline decisions.
- **Controls and gates:** each gate's checklist status and approvers, and every control of the compliance packs.
- **Tests:**
  - code tests;
  - load runs with their counts, breaks and result digest;
  - parity runs.
- **Agent records:** pinned agent versions with their governance record, and every agent run with its calls and
  cost.
- **Cutover:**
  - the approach and its reason;
  - the runbook;
  - coexistence rules;
  - the cutover gate's items.
- **Decommission:** the decommission gate's items.

Every item has a `source` with the record type, its id and the API path that returns it.

**Signing.**
- The pack is signed with the platform's vault-held Ed25519 key `platform-proof-pack`. The signed message is the
  UTF-8 text `<sha256 of the JSON>:<sha256 of the PDF>`.
- The control plane keeps the number, both digests, the signature and the key version. It refuses any change to a
  signed pack.
- The JSON and the PDF stay in the tenant database.

**Endpoints.**
- `GET /proof-packs/{id}/document` and `GET /proof-packs/{id}/pdf` return the exact signed bytes.
- `GET /proof-packs/{id}/verify` recomputes both digests and verifies the signature.
- `GET /proof-packs/signing-key` publishes the public key for each key version, so an auditor can verify a
  downloaded pack offline (`tests/test_gates.py` does exactly that).
