-- AlterTable
ALTER TABLE "artifacts" ADD COLUMN "clientNonce" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "artifacts_spaceId_userId_clientNonce_key" ON "artifacts"("spaceId", "userId", "clientNonce");
