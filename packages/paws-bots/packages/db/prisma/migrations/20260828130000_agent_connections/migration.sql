CREATE TABLE IF NOT EXISTS "agent_connections" (
    "id" TEXT NOT NULL,
    "requesterBotId" TEXT NOT NULL,
    "targetBotId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "agent_connections_requesterBotId_targetBotId_key" ON "agent_connections"("requesterBotId", "targetBotId");
CREATE INDEX IF NOT EXISTS "agent_connections_targetBotId_status_idx" ON "agent_connections"("targetBotId", "status");
