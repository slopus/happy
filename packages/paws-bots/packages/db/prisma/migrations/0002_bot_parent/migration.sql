-- AlterTable
ALTER TABLE "bots" ADD COLUMN "parentBotId" TEXT;

-- CreateIndex
CREATE INDEX "bots_parentBotId_idx" ON "bots"("parentBotId");

-- AddForeignKey
ALTER TABLE "bots" ADD CONSTRAINT "bots_parentBotId_fkey" FOREIGN KEY ("parentBotId") REFERENCES "bots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
