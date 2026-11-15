-- Old binaries may keep using unrestricted items. They cannot enforce restrictions,
-- so hide restricted items on reads AND writes, including in a system context.
-- Read limits as the table owner: tenant RLS must not hide another Space's limit
-- from an old writer that could otherwise overwrite the shared account item.
CREATE FUNCTION app_vault_item_unrestricted(credential_id text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT NOT EXISTS (
      SELECT 1 FROM public.vault_credential_limits
      WHERE "credentialId" = credential_id
        AND (public.app_rls_bypass()
          OR "userId" = NULLIF(current_setting('app.user_id', true), ''))
    )
  $$;

CREATE POLICY vault_credentials_access_version ON "vault_credentials" AS RESTRICTIVE
  USING (current_setting('app.vault_access_version', true) = '1'
    OR ("policy" = 'allow' AND app_vault_item_unrestricted("id")));

-- Run-only secrets do not identify their source item (and codes have no item name).
-- An old worker must not bypass a hidden item by reading or saving a run-only
-- replacement. Fence these rows only for owners with a restricted item in their
-- account or this Space's vault. Other owners/Spaces and non-run secrets work as before.
-- SECURITY DEFINER also avoids recursion through the vault's restrictive policy.
CREATE FUNCTION app_vault_run_unrestricted(owner_id text, space_id text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT (public.app_rls_bypass()
      OR (owner_id = NULLIF(current_setting('app.user_id', true), '')
        AND space_id = NULLIF(current_setting('app.space_id', true), '')))
    AND NOT EXISTS (
      SELECT 1 FROM public.vault_credentials v
      WHERE v."userId" = owner_id AND (v."spaceId" IS NULL OR v."spaceId" = space_id)
        AND (v."policy" <> 'allow' OR NOT public.app_vault_item_unrestricted(v.id))
    )
  $$;

-- These helpers bypass table RLS, so only the runtime role may evaluate them.
-- Their predicates above also scope direct runtime calls to the caller's tenant.
REVOKE EXECUTE ON FUNCTION app_vault_item_unrestricted(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app_vault_run_unrestricted(text, text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    GRANT EXECUTE ON FUNCTION app_vault_item_unrestricted(text) TO rakazo_app;
    GRANT EXECUTE ON FUNCTION app_vault_run_unrestricted(text, text) TO rakazo_app;
  END IF;
END $$;

CREATE POLICY secrets_vault_access_version ON "secrets" AS RESTRICTIVE
  USING ("kind" NOT LIKE 'run-login:%' AND "kind" NOT LIKE 'run-code:%'
    AND "kind" NOT LIKE 'run-code-spent:%' AND "kind" NOT LIKE 'run-secret:%'
    OR current_setting('app.vault_access_version', true) = '1'
    OR app_vault_run_unrestricted("userId", "spaceId"));
