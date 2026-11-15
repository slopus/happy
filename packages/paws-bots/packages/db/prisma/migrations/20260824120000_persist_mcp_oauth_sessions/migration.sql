CREATE TABLE "mcp_oauth_sessions" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  "endpoint" TEXT NOT NULL,
  "redirectUri" TEXT NOT NULL,
  "oauthCiphertext" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mcp_oauth_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "mcp_oauth_sessions_workspaceId_userId_createdAt_idx"
  ON "mcp_oauth_sessions"("workspaceId", "userId", "createdAt");

ALTER TABLE "mcp_oauth_sessions"
  ADD CONSTRAINT "mcp_oauth_sessions_serverId_fkey"
  FOREIGN KEY ("serverId") REFERENCES "mcp_servers"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
