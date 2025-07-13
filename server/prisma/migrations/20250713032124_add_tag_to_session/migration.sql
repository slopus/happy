/*
  Warnings:

  - A unique constraint covering the columns `[accountId,tag]` on the table `Session` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `tag` to the `Session` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "tag" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Session_accountId_tag_key" ON "Session"("accountId", "tag");
