-- Runs once when the pg-a volume is first created.
-- The keycloak role password is set by tools/dev.py (ALTER ROLE) from .local/secrets, never stored here.
CREATE ROLE keycloak LOGIN;
CREATE DATABASE keycloak OWNER keycloak;
