/*
  Warnings:

  - A unique constraint covering the columns `[username]` on the table `Account` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "username" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Account_username_key" ON "Account"("username");
