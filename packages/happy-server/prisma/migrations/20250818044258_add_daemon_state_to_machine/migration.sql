-- AlterTable
ALTER TABLE "Machine" ADD COLUMN     "daemonState" TEXT,
ADD COLUMN     "daemonStateVersion" INTEGER NOT NULL DEFAULT 0;
