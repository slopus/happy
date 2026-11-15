-- AlterTable
ALTER TABLE "mcp_servers" ADD COLUMN "healthStatus" TEXT NOT NULL DEFAULT 'unknown',
ADD COLUMN "healthMessage" TEXT,
ADD COLUMN "healthToolCount" INTEGER,
ADD COLUMN "healthCheckedAt" TIMESTAMP(3);
