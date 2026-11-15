CREATE TABLE "mcp_servers" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "transport" TEXT NOT NULL,
  "endpoint" TEXT,
  "command" TEXT,
  "args" JSONB NOT NULL DEFAULT '[]',
  "env" JSONB NOT NULL DEFAULT '{}',
  "headers" JSONB NOT NULL DEFAULT '{}',
  "secretId" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "mcp_servers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "bot_mcp_servers" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "allowAllTools" BOOLEAN NOT NULL DEFAULT true,
  "allowedTools" JSONB NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "bot_mcp_servers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mcp_servers_workspaceId_userId_slug_key" ON "mcp_servers"("workspaceId", "userId", "slug");
CREATE INDEX "mcp_servers_workspaceId_userId_idx" ON "mcp_servers"("workspaceId", "userId");
CREATE UNIQUE INDEX "bot_mcp_servers_botId_serverId_key" ON "bot_mcp_servers"("botId", "serverId");
CREATE INDEX "bot_mcp_servers_workspaceId_userId_botId_idx" ON "bot_mcp_servers"("workspaceId", "userId", "botId");
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "secrets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "bot_mcp_servers" ADD CONSTRAINT "bot_mcp_servers_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bot_mcp_servers" ADD CONSTRAINT "bot_mcp_servers_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "mcp_servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
