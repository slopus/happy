-- Row-level security for the remaining Space-owned tables, in the shape of
-- 20261021140000_row_level_security: a *_tenant policy for the Space set by the app
-- and a *_system policy for the explicit cross-tenant bypass.
--
-- The previous release reads some of these tables across Spaces inside a tenant
-- context, and runs beside this one for a few seconds after migrations apply. It
-- never sets app.rls_version, so each table also gets a *_previous_release policy
-- that keeps that release's access unchanged. This release sets app.rls_version
-- to 2 on every connection, which turns those policies off for it. A later
-- migration drops them once no deployment runs the previous release.

CREATE OR REPLACE FUNCTION app_rls_version() RETURNS integer
  LANGUAGE sql STABLE
  AS $$ SELECT COALESCE(NULLIF(current_setting('app.rls_version', true), ''), '0')::integer $$;

DO $$
DECLARE
  protected text;
BEGIN
  FOREACH protected IN ARRAY ARRAY[
    'bots', 'runs', 'tasks', 'routines', 'connections', 'mcp_servers', 'mcp_oauth_sessions',
    'bot_mcp_servers', 'computers', 'boards', 'tickets', 'ticket_comments',
    'messaging_identities', 'external_conversations', 'usage_records', 'scratchpad_items',
    'action_approval_rules', 'messaging_outbound', 'external_messages', 'steering_messages',
    'security_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', protected);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (current_setting(''app.rls_bypass'', true) = ''on'')',
      protected || '_system', protected);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (app_rls_version() < 2)',
      protected || '_previous_release', protected);
  END LOOP;

  FOREACH protected IN ARRAY ARRAY[
    'bots', 'runs', 'tasks', 'routines', 'connections', 'mcp_servers', 'mcp_oauth_sessions',
    'bot_mcp_servers', 'computers', 'boards', 'tickets', 'ticket_comments',
    'messaging_identities', 'external_conversations', 'usage_records', 'scratchpad_items',
    'action_approval_rules'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I USING ("spaceId" = NULLIF(current_setting(''app.space_id'', true), ''''))',
      protected || '_tenant', protected);
  END LOOP;
END $$;

-- Direct messages resolve their Space through the identity; group posts through the
-- thread message they mirror. A row with neither is only reachable as system.
CREATE POLICY messaging_outbound_tenant ON "messaging_outbound"
  USING (
    EXISTS (
      SELECT 1 FROM "messaging_identities" i
      WHERE i."id" = "messaging_outbound"."identityId"
        AND i."spaceId" = NULLIF(current_setting('app.space_id', true), '')
    )
    OR EXISTS (
      SELECT 1 FROM "messages" m JOIN "threads" t ON t."id" = m."threadId"
      WHERE m."id" = "messaging_outbound"."sourceMessageId"
        AND t."spaceId" = NULLIF(current_setting('app.space_id', true), '')
    )
  );

CREATE POLICY external_messages_tenant ON "external_messages"
  USING (EXISTS (
    SELECT 1 FROM "external_conversations" c
    WHERE c."id" = "external_messages"."externalConversationId"
      AND c."spaceId" = NULLIF(current_setting('app.space_id', true), '')
  ));

CREATE POLICY steering_messages_tenant ON "steering_messages"
  USING (EXISTS (
    SELECT 1 FROM "bots" b
    WHERE b."id" = "steering_messages"."botId"
      AND b."spaceId" = NULLIF(current_setting('app.space_id', true), '')
  ));

-- Security events have no tenant policy: they are written and read as system only
-- (recordSecurityEvent and the deployment security log), and stay append-only
-- because the runtime role has no UPDATE on the table.
