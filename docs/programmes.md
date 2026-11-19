# Installed-base programmes (I12)

A programme moves a product company's installed base, many customers served by several partners, with one shared
playbook. The programme owner sees every customer, and a partner sees only its own customers. Programme-wide views
hold only aggregates, never a customer's element names or business values.

## Access

| Grant | Sees |
|---|---|
| Platform, or a programme-scope role (programme owner, sales engineer, commercial manager) | Every customer of the programme |
| Partner-scope role (partner delivery lead, sales engineer, commercial manager) | Only that partner's customers |

Only the programme owner changes the programme (set-up, pods, waves, customer assignment, the portfolio plan).

## Set-up (E18.F1.S1)

`PUT /api/v1/programmes/{id}/setup` records the programme's shared playbook:
- the source and target adapters;
- the blueprint template every customer starts from;
- the packs they share;
- the segments (for example lines of business or regions);
- the Complexity Index settings and the weeks each band needs.

Partners get **pods** (`POST /programmes/{id}/partners/{partner}/pods`, with the number of customers a pod migrates
at once). The programme has **waves** (`PUT /programmes/{id}/waves/{key}`).

`PUT /programmes/{id}/customers/{tenant}` assigns each customer to one partner and a segment. The database refuses
a partner from another programme.

## Consent and the light scan (E18.F2.S1)

1. `POST /tenants/{id}/consents` records the customer's consent: signatory, title, what may be read, and where the
   signed form is.
2. `POST /tenants/{id}/fleet-scans` scans through a checked, read-only source connection.

What the scan reads:
- the object inventory;
- the data dictionary;
- the configuration inventory;
- row counts per entity and the document count;
- how many of the adapter's known traps apply.

It never reads business values, and it keeps only numbers: tables, columns, customer-specific tables, code
objects, lines of code, interface objects, configuration items, rows (and their log10), documents (and their
log10), and traps.

The database refuses a scan without an active consent for that customer. A revoked consent stays revoked: record a
new one instead.

## Migration Complexity Index (E18.F2.S2)

Each measure is normalised between a low and a high reference value and weighted. The score is
`100 × Σ weight × clamp((value − low) / (high − low), 0, 1)`.

The bands are:
- simple: below 35;
- medium: below 65;
- complex: 65 and above.

Defaults:

| Measure | Weight | Low | High |
|---|---|---|---|
| Tables | 0.10 | 50 | 1500 |
| Columns | 0.05 | 500 | 30000 |
| Customer-specific tables | 0.15 | 0 | 100 |
| Code objects | 0.15 | 0 | 800 |
| Lines of code | 0.10 | 0 | 200000 |
| Interface objects | 0.15 | 0 | 60 |
| Configuration items | 0.10 | 0 | 3000 |
| Data volume (log10 of rows) | 0.10 | 4 | 9 |
| Documents (log10) | 0.05 | 2 | 7 |
| Known traps that apply | 0.05 | 0 | 20 |

A programme can change weights (adding up to 1), ranges and band limits. Every score lists each measure's value,
range, weight and contribution.

`GET /programmes/{id}/fleet` shows each visible customer's latest score and band. Per segment it shows the mean
score, the segment's band and the band counts.

## Portfolio planner (E18.F3.S1)

`POST /programmes/{id}/portfolio-plans` places every scanned customer in one wave and one pod of its partner, using
OR-Tools CP-SAT:
- A wave can hold a customer only if it is as long as the customer's band needs.
- A pod migrates at most its capacity in a wave.
- Earlier waves are preferred.

The result lists each pod's customers per wave, which is its rotation. Every customer that cannot be placed is a
conflict with the reason:
- no partner;
- the partner has no pods;
- not scanned yet;
- no wave is long enough;
- every pod is full.

Partners see their own customers' places and pods only.

## Programme view (E18.F3.S2)

`GET /programmes/{id}/view` shows, per visible customer:
- band and score;
- partner and segment;
- gates passed per project, and the next gate;
- open risks;
- open vendor product changes;
- open reconciliation breaks;
- the last load's counts.

It also shows programme totals. The counts are read from each customer's own database; only numbers leave it.

## Commercial metering (E18.F4.S1)

`GET /programmes/{id}/metering` lists, per customer:
- band and score;
- gates passed;
- actual effort (hours imported from the delivery tool);
- elapsed days from the first project to the latest gate;
- the planned wave.

It compares effort per segment and wave (hours per customer and per score point), and lists every gate pass with
its approvers and checklist digest.

`?format=csv` exports that gate evidence for invoicing.
