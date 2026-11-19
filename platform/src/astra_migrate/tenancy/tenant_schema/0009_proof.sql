-- Proof packs (I11) name customer elements (tables, columns, objects), so their content stays in the tenant
-- database. The control plane keeps their number, digests and signature.

CREATE TABLE IF NOT EXISTS estate.proof_pack_files (
    pack_id   uuid PRIMARY KEY,
    document  text NOT NULL,   -- the exact signed bytes (canonical JSON)
    pdf       bytea NOT NULL
);
