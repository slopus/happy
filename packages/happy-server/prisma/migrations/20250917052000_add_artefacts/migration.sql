-- CreateTable
CREATE TABLE "Artifact" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "header" BYTEA NOT NULL,
    "headerVersion" INTEGER NOT NULL DEFAULT 0,
    "body" BYTEA NOT NULL,
    "bodyVersion" INTEGER NOT NULL DEFAULT 0,
    "dataEncryptionKey" BYTEA NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Artifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Artifact_accountId_idx" ON "Artifact"("accountId");

-- CreateIndex
CREATE INDEX "Artifact_accountId_updatedAt_idx" ON "Artifact"("accountId", "updatedAt" DESC);

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
