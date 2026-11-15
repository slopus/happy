ALTER TABLE "bots" ADD COLUMN "crossSpaceCommunication" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "agent_connections" ADD COLUMN "requestVersion" INTEGER NOT NULL DEFAULT 1;
