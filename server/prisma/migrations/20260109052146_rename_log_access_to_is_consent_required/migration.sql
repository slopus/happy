/*
  Warnings:

  - You are about to drop the column `logAccess` on the `PublicSessionShare` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "PublicSessionShare" DROP COLUMN "logAccess",
ADD COLUMN     "isConsentRequired" BOOLEAN NOT NULL DEFAULT false;
