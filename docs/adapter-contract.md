# Adapter contract `astra.adapters/v1`

Every legacy and target product plugs into Astra Migrate the same way: as a pack whose `content` follows this
contract. The platform supplies the engine drivers, the read-only guard, the job runner and the storage; the pack
supplies what is specific to the product. The machine-readable schema is served at `GET /api/v1/adapters/contract`
and lives in `platform/src/astra_migrate/adapters/contract.py`. A change that breaks existing adapters needs a new
contract version.

## Operations

| Operation | Source | Target | What the platform does |
|---|---|---|---|
| `connect` | yes | yes | Opens a session and reports engine, version, edition and login. A source account that can write is refused. |
| `read_metadata` | yes | | Runs every declared object-type query, records owner, last change and dependencies, and writes a coverage report. |
| `read_code` | yes | | Stores the source text of code objects (procedures, triggers, views, functions). |
| `extract` | yes | | Extracts entity rows in full or as deltas (by the entity's change column), and documents with their entity links. Counts are recorded and checked against the source. |
| `list_traps` | yes | | Evaluates the pack's traps and the traps curators added, and records which apply to the estate. |
| `load` | | yes | Loads through the vendor's APIs with OAuth2 client credentials, within the recorded rate limit. Every call is logged. There is no database load method. |
| `report_limits` | | yes | Publishes the product's constraints, each with a source, a date and a confidence. They become planning rules (`TGT-<id>`). |

## Read-only by construction

1. **Query guard.** Every statement in a source adapter pack is checked at registration and again before it runs: one
   statement, starting with `SELECT` or `WITH`, and no data-changing, DDL, permission, execution or external-access
   keyword (`INSERT`, `UPDATE`, `DELETE`, `MERGE`, `EXEC`, `INTO`, `OPENROWSET`, `GRANT`, `FOR UPDATE`, ...)
   outside string literals and comments.
2. **Account check.** The connection check fails if the login is a member of a writing role or holds `INSERT`,
   `UPDATE`, `DELETE`, `ALTER` or `CREATE` on the database or any table. Discovery and extraction cannot start
   before a passing check.
3. **Session.** Every adapter session runs in one transaction that is always rolled back.

Golden runs also try a write with the adapter's login and record that the engine refused it.

## Source adapter content

| Field | Purpose |
|---|---|
| `product` | Name and the versions covered. |
| `engines` | Supported engines (`sqlserver`, `sqlanywhere`) with minimum versions. Every object type needs a query for every engine listed. |
| `object_types` | What `read_metadata` inventories. Each query returns `name` and, where available, `schema`, `owner`, `modified_at`, `definition` (code) and `detail` (JSON). Optional `dependencies` queries return `(name, depends_on)`. `interface: true` marks types whose objects are interfaces. |
| `entities` | Business entities to extract: table, key, change column, and the ontology concept, attributes and relations they bind to. Bindings let domain rules run on this product. |
| `documents` | An embedded document store: key, name, content, and the link type and key columns with the entity each link type points to. |
| `traps` | Known problems: severity, stream, advice, sources and a detection (`object_exists` over the inventory, or a read-only `query`). Curators add more without a new pack version. |
| `golden_datasets` | Synthetic estates with expected answers, shipped in the pack (see below). |
| `validated_against_real_estate` | `false` until the queries have run on a real estate. Screens show it. |

## Target adapter content

| Field | Purpose |
|---|---|
| `load` | `rest_api` or `vendor_tool`, OAuth2 client credentials, token path, endpoints per entity, approved tools and the rate limit with its source. Unknown endpoints stay unset, and loads show as Blocked. |
| `constraints` | Each with `kind`, a statement planners follow, `applies_to` concepts, `source`, `recorded_on` and `confidence` (confirmed, reported, assumed). A `database_access` constraint is required. |
| baselines | Vendor baseline metadata in `astra.baseline/v1`, stored by name and never changed. A project is pinned to one baseline. |
| `design` (optional, I9) | What design and build need: approved `mechanisms` (with directions), the `report_access` mechanism, `retirements` with replacements, `naming` rules for customer objects, `configuration_areas`, the `forms` format and the `pages` builder, each with a source and confidence. Missing parts block their design streams. See [design.md](design.md). |

## Golden datasets

A golden dataset is a folder in the source adapter pack: `dataset.yaml` (build scripts, delta script, expected
answers), the scripts, and `expected.yaml`. The runner builds the estate on a test engine, proves the adapter's
login is read-only, and scores every operation against the expected answers: object counts and dependencies,
coverage, traps and their hits, hidden rules, interfaces, full and delta extract counts, document links, and the
violations found by the domain packs' executable rules. A pack test of kind `golden_dataset` passes only when a
golden run with the exact current pack contents passed.
