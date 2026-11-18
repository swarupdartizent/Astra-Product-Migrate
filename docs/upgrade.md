# Version delta, code conversion and the hosting checklist (I6)

## Version delta (E09.F1)

`POST /api/v1/projects/{id}/delta-runs` reads the source estate through its adapter (object inventory plus the
data dictionary's columns, or each code object's normalized code hash) and compares it with the project's pinned
target baseline. Every source object lands in exactly one group:

| Group | Meaning |
|---|---|
| `unchanged` | Same type and name in the target, same columns (or same code) |
| `renamed_or_moved` | Same name in another schema (moved), or another name with at least 80% of the same columns or the same code body (renamed) |
| `changed_behaviour` | Same name, different columns or code; the column differences are listed |
| `removed_in_target` | No counterpart; the closest candidate and its similarity are given |

Object types the baseline does not describe are listed as `not_in_scope`, never guessed. Target objects with no
source counterpart are `new_in_target`.

**Origin (E09.F1.S2).** Pass `standard_baseline_id`: a baseline registered for the *source* adapter that describes
the standard product at the customer's version. Objects are then `standard`, `customized_standard` (the customer
changed a product object) or `customer_specific`. Without one, only object types the adapter marks
`customization: true` are known to be customer-specific; everything else is `unknown`.

**Adapter fields.** `object_types[].compare_as` names the baseline type an object type is compared with (for
example, customer extension tables compared as `table`); `customization: true` marks every object of the type as a
customer extension.

**Baseline code hashes.** For code objects, `definition_sha256` in a baseline is the SHA-256 of the normalized code:
comments removed, lower case, brackets removed, `CREATE OR ALTER` read as `CREATE`, whitespace collapsed.

**Determinism.** Inputs are sorted and hashed; the run stores `input_digest` and `result_digest`. The same inputs
always give the same digests. Exports: `GET /delta-runs/{id}/export?format=csv|json` (header `X-Result-Digest`).

## Pattern advice (E09.F2.S1)

`GET /projects/{id}/pattern-advice` compares the blueprint's pattern with the newest delta. When at least 60% of
comparable source objects exist in the target unchanged, renamed or moved, a same-family upgrade fits; otherwise
cross-product mapping. Several source estates mean consolidation. When the advice disagrees with the blueprint, the
delta run puts a proposal on the review queue for the solution architect. A person decides.

## Code conversion (E10.F1)

`POST /projects/{id}/conversion-runs` converts the source's code objects to the target dialect. Supported pairs:
SQL Anywhere (Watcom-SQL) to SQL Server, and SQL Server to SQL Server (compiled as written).

The SQL Anywhere converter is rule-based and names every rule it applied: types, identity columns, defaults, date
and string functions, procedure and function headers and parameters, `DECLARE`, `IF ... END IF`, `MESSAGE`, `CALL`,
`SELECT ... INTO` variables, and row triggers whose body rejects the change. Constructs with no safe automatic
equivalent (`ON EXCEPTION RESUME`, `SIGNAL`, cursor loops, `GLOBAL AUTOINCREMENT`, `DEFAULT TIMESTAMP`,
three-argument `IFNULL`, `DATEFORMAT`, `START AT`, `BEGIN ATOMIC`, `BEFORE` triggers, other row-trigger logic) are
not guessed: the object goes to the review queue with the reason.

**Workbench.** Converted code is compiled on a SQL Server workbench (`ASTRA_WORKBENCH_SQLSERVER =
user:password@host:port/database`), never on the source or the target product. Each check runs in one transaction
that is always rolled back: the pinned baseline's tables and the source's own tables are created, then the object.
Compile errors go to review; references to objects that do not exist are listed as unresolved. Without a workbench
the run is *Blocked* with that reason.

**Recorded tests (E10.F1.S2).** `POST /projects/{id}/conversion-tests` records a case for a source object:

```json
{"object_name": "dbo.sp_order_total", "name": "two lines",
 "inputs": {"p_order_id": 7}, "outputs": ["p_total"],
 "setup": {"dbo.order_line": [{"order_id": 7, "qty": 2, "price": 10.5}]},
 "expected": {"outputs": {"p_total": "21.00"}, "rows": [[7, 2]]}}
```

`expected` may hold `value` (functions), `outputs`, `rows` (the first result set) or `error` (text the error must
contain, for triggers that must reject). Every conversion run replays each case on the workbench; differences are
listed with the case's inputs. Cases come from the customer's own recordings of the source system; the platform
does not execute code on the source.

## Hosting checklist (E10.F2.S1)

`POST /projects/{id}/checklist/sync` adds items from the pinned baseline's target adapter: its identity,
provisioning, change-window and other operational constraints, each with its source and confidence. Single sign-on,
multi-factor authentication, network access and printing are always on the list. Where the adapter records nothing
about an area, a generic item says so and asks for the arrangement to be confirmed with the vendor.

Each item has an owner and a status (`open`, `in_progress`, `done`, `not_applicable`). Closing needs an owner and a
note. Agents cannot update items (database trigger).
