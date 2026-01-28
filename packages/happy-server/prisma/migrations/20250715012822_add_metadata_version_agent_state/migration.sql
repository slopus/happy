-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "agentState" TEXT,
ADD COLUMN     "agentStateVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "metadataVersion" INTEGER NOT NULL DEFAULT 0;
