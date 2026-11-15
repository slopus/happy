-- AlterTable
ALTER TABLE "threads" ADD COLUMN "historyCompactionSummary" TEXT;
ALTER TABLE "threads" ADD COLUMN "historyCompactionGeneration" INTEGER NOT NULL DEFAULT 0;
