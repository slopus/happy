-- Any session could set app.rls_bypass, so SQL that ran for one tenant could turn the
-- cross-tenant bypass on. The *_system policies now go through app_rls_bypass(), which
-- the deferred 20261114120100_rls_bypass_key_required makes also require
-- app.rls_bypass_key: a key derived from the runtime login's password (rlsBypassKey in
-- packages/db), checked against a digest `pnpm db:migrate` stores where the runtime
-- role cannot read it. Until then it accepts the bypass alone, as the previous release
-- running beside this one sends no key.

CREATE SCHEMA IF NOT EXISTS rakazo_private;
REVOKE ALL ON SCHEMA rakazo_private FROM PUBLIC;

CREATE TABLE rakazo_private.rls_bypass_keys (
  digest BYTEA PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE FUNCTION app_rls_bypass() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$ SELECT coalesce(current_setting('app.rls_bypass', true) = 'on', false) $$;

-- Wrapped in a subquery so it runs once per statement, not once per row.
DO $$
DECLARE
  policy record;
BEGIN
  FOR policy IN
    SELECT p.polname, c.relname FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
    WHERE c.relnamespace = 'public'::regnamespace
      AND pg_get_expr(p.polqual, p.polrelid) = '(current_setting(''app.rls_bypass''::text, true) = ''on''::text)'
      AND p.polwithcheck IS NULL
  LOOP
    EXECUTE format('ALTER POLICY %I ON %I USING ((SELECT app_rls_bypass()))', policy.polname, policy.relname);
  END LOOP;
END $$;

-- The *_previous_release policies from 20261022120000 gave every row to a session that
-- did not set app.rls_version. Every running release sets it, so they only served a
-- session that cleared it on purpose.
DO $$
DECLARE
  policy record;
BEGIN
  FOR policy IN
    SELECT p.polname, c.relname FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
    WHERE c.relnamespace = 'public'::regnamespace AND p.polname LIKE '%\_previous\_release'
  LOOP
    EXECUTE format('DROP POLICY %I ON %I', policy.polname, policy.relname);
  END LOOP;
END $$;

DROP FUNCTION IF EXISTS app_rls_version();
