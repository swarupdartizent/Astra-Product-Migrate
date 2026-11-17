-- Tenant database base schema. Runs as the tenant's own login role, which owns everything it creates.
CREATE SCHEMA IF NOT EXISTS estate;

CREATE TABLE IF NOT EXISTS estate.tenant_info (
    key        text PRIMARY KEY,
    value      jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Values protected with the tenant's own key (envelope encryption through the key service).
CREATE TABLE IF NOT EXISTS estate.protected_objects (
    id          uuid PRIMARY KEY,
    kind        text NOT NULL,
    ciphertext  text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
