-- deferred
-- Require app.rls_bypass_key now that the release that sent no key has stopped (see
-- 20261114120000_rls_bypass_key). A runtime login with no password has no key, so its
-- install keeps the plain bypass, and `pnpm db:migrate` warns about it.
CREATE OR REPLACE FUNCTION app_rls_bypass() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT coalesce(current_setting('app.rls_bypass', true) = 'on', false) AND (
      NOT EXISTS (SELECT 1 FROM rakazo_private.rls_bypass_keys)
      OR EXISTS (
        SELECT 1 FROM rakazo_private.rls_bypass_keys
        WHERE digest = sha256(convert_to(coalesce(current_setting('app.rls_bypass_key', true), ''), 'UTF8'))
      )
    )
  $$;
