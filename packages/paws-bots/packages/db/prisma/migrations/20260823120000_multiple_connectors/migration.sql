-- Identify the connector that owns each external account. Existing rows were
-- all created by Composio, so the backfill/default is lossless.
ALTER TABLE "connections"
ADD COLUMN "connectorId" TEXT NOT NULL DEFAULT 'composio';

DROP INDEX IF EXISTS "connections_workspaceId_userId_idx";
CREATE INDEX "connections_workspaceId_userId_connectorId_idx"
ON "connections"("workspaceId", "userId", "connectorId");

-- Capability installs may reference an encrypted credential. The value itself
-- remains in secrets; this column is only an opaque identifier.
ALTER TABLE "capability_installs"
ADD COLUMN "secretId" TEXT;
