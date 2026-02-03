/*
  Warnings:

  - A unique constraint covering the columns `[githubUserId]` on the table `Account` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "Account_githubUserId_key" ON "Account"("githubUserId");
