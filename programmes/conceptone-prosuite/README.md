# Reference programme: ConceptOne to Pro Suite Base

Configuration for the reference case: an Insurity ConceptOne estate (SQL Server or SQL Anywhere, customer-hosted)
upgraded to Insurity Pro Suite Base (Insurity-hosted SQL Server tenant). Platform code knows nothing about it;
everything specific lives in `packs/` and here.

## Packs

| Pack | Type | Status |
|---|---|---|
| `core-ontology@1.0.0` | domain | Shared business concepts. |
| `pc-insurance@1.1.0` | domain | P&C with the MGA and delegated authority extension; passes the synthetic golden dataset. |
| `conceptone-source@1.1.0` | source adapter | **Unvalidated.** SQL Server catalogue, dictionary and configuration queries proven on the synthetic estate; entity and configuration tables follow the synthetic estate; SQL Anywhere queries unproven. 1.1.0 adds discovery: dictionary, configuration readers and the product's own client names. |
| `prosuite-base-target@1.0.0` | target adapter | **Unvalidated.** Constraints reported by product experts (fit assessment, 17 Nov 2026); API endpoints unknown, so loads are Blocked. |
| `sox-itgc`, `soc1-ssae18`, `naic-data-security`, `us-insurance-record-retention`, `us-surplus-lines-filing` | compliance | Pass their tests; **not published** until a named compliance specialist reviews them. |

## Synthetic golden estate

`packs/conceptone-source/golden/synthetic-v2` is an invented SQL Server estate shaped after public descriptions of
ConceptOne. It is not a copy of any customer or vendor database. It has 40 policies, carrier splits, invoices with
surplus lines tax and fees, commissions with sub-producer splits, claims, premium finance, bordereaux, 30 documents
of several types and ages, two books with their own products, rating tables and forms, user-defined tables,
validation rules, workflows, security profiles, External Programs, procedures, triggers and views, and 120 days of
login and query records. Seeded errors, hidden rules, undocumented interfaces, unused elements, book differences
and the expected coverage report are listed in `expected.yaml`; the golden run scores discovery against them.

Regenerate the data and expected answers (deterministic):

```bash
py -3.13 programmes/conceptone-prosuite/tools/make_golden.py
```

`baselines/synthetic-prosuite-base-v1.yaml` is a synthetic stand-in for the Pro Suite Base baseline, with documented
differences for the version delta engine (I6). Replace it with Insurity's baseline when provided.

## Tests

```bash
cd platform && .venv/Scripts/python -m pytest -c pyproject.toml ../programmes/conceptone-prosuite/tests
```

## Needed from Insurity

A ConceptOne reference database (to validate the source adapter), a Pro Suite Base sandbox with API documentation
and OAuth2 credentials, the Pro Suite Base baseline metadata, the approved bulk load tools, and named SMEs.
