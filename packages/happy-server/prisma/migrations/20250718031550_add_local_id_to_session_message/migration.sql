/*
  Warnings:

  - A unique constraint covering the columns `[sessionId,localId]` on the table `SessionMessage` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "SessionMessage" ADD COLUMN     "localId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "SessionMessage_sessionId_localId_key" ON "SessionMessage"("sessionId", "localId");
