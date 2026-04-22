-- ════════════════════════════════════════════════════════════════
--  Migration 001 — create the six domain schemas
--
--  Quantorus365 Postgres layout is domain-partitioned so that
--  queries stay grep-friendly (auth.users, market.candles) and
--  so we can grant/revoke by schema if the app is ever split.
-- ════════════════════════════════════════════════════════════════

BEGIN;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS master;
CREATE SCHEMA IF NOT EXISTS market;
CREATE SCHEMA IF NOT EXISTS intel;
CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS ops;

-- UUIDs are preferred for public identifiers; gen_random_uuid()
-- ships with pgcrypto on every modern PG and avoids needing the
-- uuid-ossp extension.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- CITEXT is used for case-insensitive emails in auth.users. Must be
-- created before any migration that references the CITEXT type.
CREATE EXTENSION IF NOT EXISTS citext;

COMMIT;
