-- Least-privilege runtime role and row-level security for user content.
--
-- Migrations keep running as the owner role. The app connects as a login role
-- that is a member of rakazo_app: DML on the app tables only, no CREATE on the
-- schema, no superuser, no BYPASSRLS. `pnpm db:migrate` creates that login from
-- DATABASE_URL and grants it rakazo_app (see apps/api/src/cli/provision-database.ts).
--
-- Table owners and superusers bypass these policies, so an install that still
-- connects the app as the owner keeps working unchanged until it switches.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    BEGIN
      CREATE ROLE rakazo_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE WARNING 'Cannot create role rakazo_app (the migration role lacks CREATEROLE). Create it with NOLOGIN NOBYPASSRLS and rerun the grants in this migration; until then the app must connect as the owner and row-level security is not enforced.';
    END;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO rakazo_app', current_database());
    GRANT USAGE ON SCHEMA public TO rakazo_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rakazo_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rakazo_app;
    REVOKE ALL ON TABLE "_prisma_migrations" FROM rakazo_app;
    -- Append-only: inserted and, past retention, deleted, never rewritten.
    REVOKE UPDATE ON TABLE "security_events" FROM rakazo_app;
    -- Tables created by later migrations (run by this same owner role).
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rakazo_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO rakazo_app;
  END IF;
END $$;

-- PostgreSQL 15+ already denies this; older servers let every role create objects.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Every protected table gets two permissive policies:
--   *_tenant: rows of the Space (or user) set for this transaction by the app;
--   *_system: the explicit cross-tenant bypass (runAsSystem in packages/db).
-- With neither setting, a query sees no rows and writes are rejected.

ALTER TABLE "threads" ENABLE ROW LEVEL SECURITY;
CREATE POLICY threads_tenant ON "threads"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY threads_system ON "threads"
  USING (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;
CREATE POLICY messages_tenant ON "messages"
  USING (EXISTS (
    SELECT 1 FROM "threads" t
    WHERE t."id" = "messages"."threadId"
      AND t."spaceId" = NULLIF(current_setting('app.space_id', true), '')
  ));
CREATE POLICY messages_system ON "messages"
  USING (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY events_tenant ON "events"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY events_system ON "events"
  USING (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "memory_documents" ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_documents_tenant ON "memory_documents"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY memory_documents_system ON "memory_documents"
  USING (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "memory_revisions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_revisions_tenant ON "memory_revisions"
  USING (EXISTS (
    SELECT 1 FROM "memory_documents" d
    WHERE d."id" = "memory_revisions"."documentId"
      AND d."spaceId" = NULLIF(current_setting('app.space_id', true), '')
  ));
CREATE POLICY memory_revisions_system ON "memory_revisions"
  USING (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "artifacts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY artifacts_tenant ON "artifacts"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY artifacts_system ON "artifacts"
  USING (current_setting('app.rls_bypass', true) = 'on');

-- Space secrets belong to the Space; account-level secrets (no Space) to their user.
ALTER TABLE "secrets" ENABLE ROW LEVEL SECURITY;
CREATE POLICY secrets_tenant ON "secrets"
  USING (
    "spaceId" = NULLIF(current_setting('app.space_id', true), '')
    OR ("spaceId" IS NULL AND "userId" = NULLIF(current_setting('app.user_id', true), ''))
  );
CREATE POLICY secrets_system ON "secrets"
  USING (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "bot_secrets" ENABLE ROW LEVEL SECURITY;
CREATE POLICY bot_secrets_tenant ON "bot_secrets"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY bot_secrets_system ON "bot_secrets"
  USING (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "agent_secrets" ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_secrets_tenant ON "agent_secrets"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY agent_secrets_system ON "agent_secrets"
  USING (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "user_model_credentials" ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_model_credentials_tenant ON "user_model_credentials"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY user_model_credentials_system ON "user_model_credentials"
  USING (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "user_voice_credentials" ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_voice_credentials_tenant ON "user_voice_credentials"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY user_voice_credentials_system ON "user_voice_credentials"
  USING (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "taught_skills" ENABLE ROW LEVEL SECURITY;
CREATE POLICY taught_skills_tenant ON "taught_skills"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY taught_skills_system ON "taught_skills"
  USING (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "agent_skills" ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_skills_tenant ON "agent_skills"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY agent_skills_system ON "agent_skills"
  USING (current_setting('app.rls_bypass', true) = 'on');
