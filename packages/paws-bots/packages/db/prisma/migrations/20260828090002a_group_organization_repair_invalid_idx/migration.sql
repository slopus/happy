-- IF NOT EXISTS on the concurrent creates can skip an INVALID leftover and still
-- succeed. Repair only invalid same-name indexes, then create if still missing.
-- Non-concurrent CREATE is intentional: CONCURRENTLY cannot run inside DO, and this
-- path only runs when a prior concurrent build left (or skipped) a broken index.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_index i ON i.indexrelid = c.oid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'chat_groups_workspaceId_userId_archivedAt_pinned_updatedAt_idx'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX IF EXISTS "chat_groups_workspaceId_userId_archivedAt_pinned_updatedAt_idx"';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'chat_groups_workspaceId_userId_archivedAt_pinned_updatedAt_idx'
  ) THEN
    EXECUTE 'CREATE INDEX "chat_groups_workspaceId_userId_archivedAt_pinned_updatedAt_idx" ON "chat_groups"("workspaceId", "userId", "archivedAt", "pinned", "updatedAt")';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_index i ON i.indexrelid = c.oid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'chat_groups_sectionId_idx'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX IF EXISTS "chat_groups_sectionId_idx"';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'chat_groups_sectionId_idx'
  ) THEN
    EXECUTE 'CREATE INDEX "chat_groups_sectionId_idx" ON "chat_groups"("sectionId")';
  END IF;
END $$;
