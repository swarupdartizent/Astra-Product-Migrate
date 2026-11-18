"""Generate the synthetic golden estate's data, delta script and expected answers.

    py -3.13 programmes/conceptone-prosuite/tools/make_golden.py

Deterministic (fixed seed). Writes into packs/conceptone-source/golden/synthetic-v1/:
  data.sql      rows for every table, including seeded errors
  delta.sql     changes applied after the full extract, for delta extraction
  expected.yaml the known correct answers the golden runner scores against

Seeded errors (each listed in expected.yaml):
  - 2 policies whose term ends before it starts
  - 2 claims whose loss date is outside the policy term
  - 1 policy whose carrier splits are off by one cent
  - 1 invoice whose total does not equal its lines
  - 1 commission whose sub-producer splits do not add up
  - 2 documents linked to records that do not exist
"""

from __future__ import annotations

import random
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "packs" / "conceptone-source" / "golden" / "synthetic-v1"
R = random.Random(20261118)  # noqa: S311 - reproducible synthetic data, not security
C = Decimal("0.01")


def money(x: float | Decimal) -> Decimal:
    return Decimal(str(x)).quantize(C, rounding=ROUND_HALF_UP)


def q(v: object) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, int | Decimal):
        return str(v)
    if isinstance(v, datetime):
        return f"'{v:%Y-%m-%dT%H:%M:%S}'"
    if isinstance(v, date):
        return f"'{v:%Y-%m-%d}'"
    if isinstance(v, bytes):
        return "0x" + v.hex()
    return "N'" + str(v).replace("'", "''") + "'"


rows: dict[str, list[tuple[object, ...]]] = {}
cols: dict[str, tuple[str, ...]] = {}


def add(table: str, columns: tuple[str, ...], *values: object) -> None:
    cols[table] = columns
    rows.setdefault(table, []).append(values)


def stamp(days_ago: int) -> datetime:
    return datetime(2026, 11, 1, 9, 0, 0) - timedelta(days=days_ago, minutes=R.randint(0, 600))


# ---------------------------------------------------------------- reference data
for i, (code, name) in enumerate([("MGA", "MGA programme book"), ("CARR", "Carrier book")], 1):
    add("dbo.Book", ("BookID", "Code", "Name", "ModifiedOn"), i, code, name, stamp(400))
carriers = [("NORTH", "Northgate Specialty (synthetic)", "90001"), ("HARB", "Harbour Mutual (synthetic)", "90002"),
            ("KEST", "Kestrel Indemnity (synthetic)", "90003"), ("LYN", "Lynton Re (synthetic)", "90004")]
for i, (code, name, naic) in enumerate(carriers, 1):
    add("dbo.Carrier", ("CarrierID", "Code", "Name", "NAICCode", "ModifiedOn"), i, code, name, naic, stamp(380))
lobs = [("CMP", "Commercial multiple peril"), ("OL", "Other liability"), ("IM", "Inland marine"),
        ("CAL", "Commercial auto liability"), ("FIRE", "Fire"), ("HO", "Homeowners multiple peril")]
for code, name in lobs:
    add("dbo.LineOfBusiness", ("LOBCode", "Name"), code, name)
states = ["FL", "TX", "CA", "GA", "NY", "LA"]

entity_cols = ("EntityID", "EntityType", "Name", "TaxID", "State", "ModifiedOn")
eid = 0
insureds = []
for n in range(20):
    eid += 1
    insureds.append(eid)
    add("dbo.Entity", entity_cols, eid, "I", f"Synthetic Insured {n + 1:02d} LLC", f"99-{1000000 + eid}",
        R.choice(states), stamp(R.randint(30, 360)))
producer_entities = []
for n in range(6):
    eid += 1
    producer_entities.append(eid)
    add("dbo.Entity", entity_cols, eid, "P", f"Synthetic Agency {n + 1}", f"98-{2000000 + eid}", R.choice(states),
        stamp(R.randint(30, 360)))
for n in range(4):
    eid += 1
    add("dbo.Entity", entity_cols, eid, "C", f"Synthetic Carrier Contact {n + 1}", None, R.choice(states),
        stamp(R.randint(30, 360)))
for i, e in enumerate(producer_entities, 1):
    add("dbo.Producer", ("ProducerID", "EntityID", "LicenseNo", "ModifiedOn"), i, e, f"LIC{700000 + i}",
        stamp(R.randint(30, 360)))
producers = list(range(1, 7))

# ---------------------------------------------------------------- policies and money
bad_term = {7, 23}
split_off = 12
invoice_off = 31
commission_off = 18
claims_out_of_term = []
policy_cols = ("PolicyID", "PolicyNumber", "BookID", "InsuredID", "ProducerID", "LOBCode", "State", "EffDate",
               "ExpDate", "WrittenPremium", "BillType", "Status", "ModifiedOn")
policies: dict[int, dict[str, object]] = {}
split_id = line_id = comm_split_id = 0
for pid in range(1, 41):
    eff = date(2025, 1, 1) + timedelta(days=R.randint(0, 600))
    exp = eff + timedelta(days=365)
    if pid in bad_term:
        exp = eff - timedelta(days=R.randint(5, 40))
    premium = money(R.randint(2500, 95000) + R.randint(0, 99) / 100)
    producer = R.choice(producers)
    policies[pid] = {"eff": eff, "exp": exp, "premium": premium, "producer": producer}
    add("dbo.Policy", policy_cols, pid, f"SYN-{2025000 + pid}", R.choice([1, 2]), R.choice(insureds), producer,
        R.choice(lobs)[0], R.choice(states), eff, exp, premium, R.choice(["D", "A"]),
        "ACTIVE" if pid % 9 else "EXPIRED", stamp(R.randint(20, 300)))

    # carrier splits: shares add to 100%, amounts add to the premium to the cent
    n = R.choice([1, 2, 3])
    chosen = R.sample(range(1, 5), n)
    shares = [Decimal("1")] if n == 1 else ([Decimal("0.6"), Decimal("0.4")] if n == 2
                                            else [Decimal("0.5"), Decimal("0.3"), Decimal("0.2")])
    amounts = [money(premium * s) for s in shares]
    amounts[-1] = premium - sum(amounts[:-1])
    if pid == split_off:
        amounts[-1] += C
    for carrier, share, amt in zip(chosen, shares, amounts, strict=True):
        split_id += 1
        add("dbo.CarrierSplit", ("SplitID", "PolicyID", "CarrierID", "SharePct", "PremiumShare", "ModifiedOn"),
            split_id, pid, carrier, (share * 100).quantize(Decimal("0.0001")), amt, stamp(R.randint(20, 300)))

    # invoice: premium + surplus lines tax + stamping fee + policy fee
    sl_tax = money(premium * Decimal("0.0494"))
    stamping = money(premium * Decimal("0.0018"))
    fee = money(R.choice([150, 200, 250]))
    lines = [("PREM", premium), ("SLTAX", sl_tax), ("STAMP", stamping), ("FEE", fee)]
    total = sum((a for _, a in lines), Decimal("0"))
    if pid == invoice_off:
        total += money(1)
    add("dbo.Invoice", ("InvoiceID", "PolicyID", "InvoiceDate", "TotalAmount", "ModifiedOn"), pid, pid, eff, total,
        stamp(R.randint(20, 300)))
    for lt, amt in lines:
        line_id += 1
        add("dbo.InvoiceLine", ("LineID", "InvoiceID", "LineType", "Amount", "ModifiedOn"), line_id, pid, lt, amt,
            stamp(R.randint(20, 300)))

    # commission with sub-producer splits that add up
    rate = Decimal(R.choice(["0.1000", "0.1250", "0.1500"]))
    comm = money(premium * rate)
    add("dbo.Commission", ("CommissionID", "PolicyID", "ProducerID", "Rate", "Amount", "ModifiedOn"), pid, pid,
        producer, rate, comm, stamp(R.randint(20, 300)))
    parts = [comm] if R.random() < 0.5 else [money(comm * Decimal("0.7")), comm - money(comm * Decimal("0.7"))]
    if pid == commission_off:
        parts = [money(comm * Decimal("0.7")), comm - money(comm * Decimal("0.7")) - money(5)]
    for k, amt in enumerate(parts):
        comm_split_id += 1
        sub = producer if k == 0 else R.choice([x for x in producers if x != producer])
        add("dbo.CommissionSplit", ("CommSplitID", "CommissionID", "SubProducerID", "Amount", "ModifiedOn"),
            comm_split_id, pid, sub, amt, stamp(R.randint(20, 300)))

# premium finance on five agency-billed policies
for fid, pid in enumerate([3, 9, 15, 27, 36], 1):
    add("dbo.PremiumFinance", ("FinanceID", "PolicyID", "FinanceCoName", "AmountFinanced", "ModifiedOn"), fid, pid,
        "Synthetic Premium Finance Co", money(Decimal(str(policies[pid]["premium"])) * Decimal("0.75")),
        stamp(R.randint(20, 300)))

# claims: two with a loss outside the policy term
claim_cols = ("ClaimID", "ClaimNumber", "PolicyID", "LossDate", "ReportedDate", "Status", "ReserveAmount", "ModifiedOn")
claim_policies = [p for p in policies if p not in bad_term]
R.shuffle(claim_policies)
for cid, pid in enumerate(claim_policies[:15], 1):
    eff, exp = policies[pid]["eff"], policies[pid]["exp"]
    assert isinstance(eff, date) and isinstance(exp, date)
    loss = eff + timedelta(days=R.randint(1, 360))
    if cid == 4:
        loss = exp + timedelta(days=12)
        claims_out_of_term.append(cid)
    if cid == 11:
        loss = eff - timedelta(days=3)
        claims_out_of_term.append(cid)
    add("dbo.Claim", claim_cols, cid, f"CLM-{30000 + cid}", pid, loss, loss + timedelta(days=R.randint(1, 20)),
        R.choice(["OPEN", "CLOSED"]), money(R.randint(1000, 60000)), stamp(R.randint(10, 200)))

for bid in range(1, 9):
    add("dbo.Bordereau", ("BordereauID", "CarrierID", "Kind", "PeriodEnd", "TotalPremium", "ModifiedOn"), bid,
        (bid - 1) % 4 + 1, "P" if bid <= 4 else "C", date(2026, 9, 30), money(R.randint(50000, 400000)), stamp(30))

# documents: policy, claim and party links; two point at records that do not exist
doc_cols = ("DocID", "DocName", "LinkType", "LinkKey", "CreatedOn", "Content", "ModifiedOn")
broken = []
for did in range(1, 31):
    kind = ["P", "C", "E"][did % 3]
    key = R.randint(1, 40) if kind == "P" else (R.randint(1, 15) if kind == "C" else R.randint(1, 30))
    if did in (8, 22):
        key = 9000 + did
        broken.append(str(did))
    body = f"%PDF-1.4\n% synthetic document {did} for golden estate v1\n".encode()
    add("dbo.FileCabinet", doc_cols, did, f"Document {did:03d}.pdf", kind, key, stamp(R.randint(10, 300)), body,
        stamp(R.randint(10, 300)))

# configuration objects
for rid, (name, table, expr, msg) in enumerate([
        ("POL_EFF_REQUIRED", "Policy", "EffDate IS NOT NULL", "Effective date is required"),
        ("POL_PREMIUM_POSITIVE", "Policy", "WrittenPremium > 0", "Premium must be positive"),
        ("CLM_LOSS_DATE", "Claim", "LossDate <= ReportedDate", "Loss date must precede the report date"),
        ("ENT_TAXID_FORMAT", "Entity", "TaxID LIKE '__-_______'", "Tax ID format is NN-NNNNNNN")], 1):
    add("dbo.ValidationRule", ("RuleID", "RuleName", "TableName", "Expression", "Message", "ModifiedBy", "ModifiedOn"),
        rid, name, table, expr, msg, "cfg.admin", stamp(200 + rid))
workflows = [("NEW_BUSINESS_REVIEW", "PolicyBound", False), ("CLAIM_FNOL_ROUTING", "ClaimCreated", False),
             ("DESKTOP_RENEWAL_LETTERS", "RenewalDue", True)]
step = 0
for wid, (name, ev, desktop) in enumerate(workflows, 1):
    add("dbo.WorkflowDefinition", ("WorkflowID", "Name", "TriggerEvent", "IsDesktopOnly", "ModifiedBy", "ModifiedOn"),
        wid, name, ev, desktop, "cfg.admin", stamp(150 + wid))
    for seq, action in enumerate(["Assign", "Review", "Notify"], 1):
        step += 1
        add("dbo.WorkflowStep", ("StepID", "WorkflowID", "Seq", "Action"), step, wid, seq, action)
for pid_, (name, rights) in enumerate([("Underwriter", ["POLICY_EDIT", "POLICY_BIND"]),
                                       ("Accounting", ["CASH_POST", "LEDGER_VIEW"]),
                                       ("Claims", ["CLAIM_EDIT", "RESERVE_SET"])], 1):
    add("dbo.SecurityProfile", ("ProfileID", "Name", "ModifiedBy", "ModifiedOn"), pid_, name, "sec.admin",
        stamp(100 + pid_))
    for r in rights:
        add("dbo.SecurityProfileRight", ("ProfileID", "RightCode", "Allowed"), pid_, r, True)
externals = [("Rating export", "C:\\C1\\ext\\rateexport.exe /db", "PolicyBound", True, None),
             ("Outlook correspondence", "OUTLOOK.Application (COM)", "LetterRequested", False, None),
             ("Carrier statement upload", "C:\\C1\\ext\\stmtupload.exe", "MonthEnd", False,
              "https://sftp.carrier.example/statements")]
for xid, (name, cmd, ev, db, ep) in enumerate(externals, 1):
    add("dbo.ExternalProgram", ("ProgramID", "Name", "CommandLine", "TriggerEvent", "ConnectsToDatabase", "Endpoint",
                                "ModifiedBy", "ModifiedOn"), xid, name, cmd, ev, db, ep, "cfg.admin", stamp(90 + xid))

for nid in range(1, 6):
    add("dbo.usr_InspectionNotes", ("NoteID", "PolicyID", "Note", "ModifiedOn"), nid, nid * 3, f"Inspection note {nid}",
        stamp(50))
for cid_ in range(1, 5):
    add("dbo.usr_CarrierCodes", ("CarrierID", "ExternalCode"), cid_, f"EXT-{cid_:03d}")
for pid in (2, 5, 8):
    add("dbo.usr_RenewalFlags", ("PolicyID", "Flag"), pid, "MANUAL_REVIEW")


def insert_sql() -> str:
    out = ["-- Generated by programmes/conceptone-prosuite/tools/make_golden.py. Synthetic data only.",
           "SET NOCOUNT ON;"]
    order = ["dbo.Book", "dbo.Carrier", "dbo.LineOfBusiness", "dbo.Entity", "dbo.Producer", "dbo.Policy",
             "dbo.CarrierSplit", "dbo.Invoice", "dbo.InvoiceLine", "dbo.Commission", "dbo.CommissionSplit",
             "dbo.PremiumFinance", "dbo.Claim", "dbo.Bordereau", "dbo.FileCabinet", "dbo.ValidationRule",
             "dbo.WorkflowDefinition", "dbo.WorkflowStep", "dbo.SecurityProfile", "dbo.SecurityProfileRight",
             "dbo.ExternalProgram", "dbo.usr_InspectionNotes", "dbo.usr_CarrierCodes", "dbo.usr_RenewalFlags"]
    for t in order:
        c = ", ".join(cols[t])
        for r in rows[t]:
            out.append(f"INSERT INTO {t} ({c}) VALUES ({', '.join(q(v) for v in r)});")
        out.append("GO")
    return "\n".join(out) + "\n"


DELTA_TS = datetime(2026, 11, 20, 8, 0, 0)
delta = ["-- Changes after the full extract (all stamped later than any existing row).", "SET NOCOUNT ON;",
         f"UPDATE dbo.Policy SET Status = 'RENEWED', ModifiedOn = {q(DELTA_TS)} WHERE PolicyID IN (2, 14, 33);",
         f"INSERT INTO dbo.Claim (ClaimID, ClaimNumber, PolicyID, LossDate, ReportedDate, Status, ReserveAmount, "
         f"ModifiedOn) VALUES (16, 'CLM-30016', 2, '2026-03-02', '2026-03-05', 'OPEN', 4000.00, {q(DELTA_TS)}), "
         f"(17, 'CLM-30017', 14, '2026-04-11', '2026-04-12', 'OPEN', 2500.00, {q(DELTA_TS)});",
         f"UPDATE dbo.Invoice SET ModifiedOn = {q(DELTA_TS)} WHERE InvoiceID = 5;", "GO"]

entity_tables = {"book": "dbo.Book", "carrier": "dbo.Carrier", "party": "dbo.Entity", "producer": "dbo.Producer",
                 "policy": "dbo.Policy", "carrier_split": "dbo.CarrierSplit", "invoice": "dbo.Invoice",
                 "invoice_line": "dbo.InvoiceLine", "commission": "dbo.Commission",
                 "commission_split": "dbo.CommissionSplit", "claim": "dbo.Claim", "bordereau": "dbo.Bordereau",
                 "premium_finance": "dbo.PremiumFinance"}
delta_counts = dict.fromkeys(entity_tables, 0)
delta_counts.update({"policy": 3, "claim": 2, "invoice": 1})

expected = {
    "synthetic": True,
    "metadata": {"counts": {"table": 22, "user_defined_table": 3, "view": 2, "procedure": 3, "function": 1,
                            "trigger": 3, "validation_rule": 4, "workflow": 3, "security_profile": 3,
                            "external_program": 3},
                 # Dependencies the engine catalogue can see, checked by hand against schema.sql.
                 # dbo.usp_BordereauExtract builds its SQL at run time, so the catalogue cannot see that it reads
                 # dbo.vw_BordereauPremium and writes WAREHOUSE.dw.dbo.Premium; the linked-server trap flags it, and
                 # the Code Reader (I5) is expected to find those two from the code text.
                 "dependencies": ["dbo.fn_PolicyTermDays->dbo.Policy", "dbo.trg_Invoice_Audit->dbo.AuditLog",
                                  "dbo.trg_Policy_StatusGuard->dbo.Claim", "dbo.usp_CalcCommission->dbo.Commission",
                                  "dbo.usp_CalcCommission->dbo.Policy", "dbo.usp_PostPayment->dbo.AuditLog",
                                  "dbo.usp_PostPayment->dbo.Invoice", "dbo.vw_BordereauPremium->dbo.CarrierSplit",
                                  "dbo.vw_PolicySummary->dbo.Entity", "dbo.vw_PolicySummary->dbo.Policy"]},
    "traps": {
        "C1-UDT-NO-PRIMARY-KEY": ["dbo.usr_CarrierCodes"],
        "C1-EXTPROG-DIRECT-DB": ["Rating export"],
        "C1-HIDDEN-LINKED-SERVER": ["dbo.usp_BordereauExtract"],
        "C1-TRIGGER-BUSINESS-RULE": ["dbo.trg_Claim_ReserveGuard", "dbo.trg_Policy_StatusGuard"],
        "C1-DESKTOP-ONLY-WORKFLOW": ["DESKTOP_RENEWAL_LETTERS"],
        "C1-DOC-ORPHAN-LINK": None,
    },
    "hidden_rules": ["dbo.trg_Claim_ReserveGuard", "dbo.trg_Policy_StatusGuard"],
    "interfaces": ["external_program:Carrier statement upload", "external_program:Outlook correspondence",
                   "external_program:Rating export", "trap:C1-HIDDEN-LINKED-SERVER:dbo.usp_BordereauExtract"],
    "extract": {"full": {k: len(rows[v]) for k, v in entity_tables.items()},
                "documents": len(rows["dbo.FileCabinet"]), "broken_links": broken, "delta": delta_counts},
    "rules": {"PC-POLICY-TERM": sorted(str(p) for p in bad_term),
              "PC-CLAIM-IN-FORCE": sorted(str(c) for c in claims_out_of_term),
              "PC-SPLIT-RECONCILE": [str(split_off)],
              "PC-INVOICE-RECONCILE": [str(invoice_off)],
              "PC-COMMISSION-SPLIT-RECONCILE": [str(commission_off)]},
    "concepts": ["core.party", "pc.book", "pc.carrier", "pc.producer", "pc.policy", "pc.carrier_split", "pc.invoice",
                 "pc.invoice_line", "pc.commission", "pc.commission_split", "pc.claim", "pc.bordereau",
                 "pc.premium_finance_agreement"],
}
expected["traps"] = {k: v for k, v in expected["traps"].items() if v is not None} | {"C1-DOC-ORPHAN-LINK": []}

OUT.mkdir(parents=True, exist_ok=True)
(OUT / "data.sql").write_text(insert_sql(), encoding="utf-8")
(OUT / "delta.sql").write_text("\n".join(delta) + "\n", encoding="utf-8")
header = ("# Known correct answers for the SYNTHETIC golden estate v1. Generated by make_golden.py;\n"
          "# 'dependencies' is added after manual verification against the built estate.\n")
(OUT / "expected.yaml").write_text(header + yaml.safe_dump(expected, sort_keys=False), encoding="utf-8")
print(f"wrote {OUT}")
