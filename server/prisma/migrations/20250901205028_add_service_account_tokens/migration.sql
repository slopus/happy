-- CreateTable
CREATE TABLE "ServiceAccountToken" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "token" BYTEA NOT NULL,
    "metadata" JSONB,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceAccountToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ServiceAccountToken_accountId_idx" ON "ServiceAccountToken"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceAccountToken_accountId_vendor_key" ON "ServiceAccountToken"("accountId", "vendor");

-- AddForeignKey
ALTER TABLE "ServiceAccountToken" ADD CONSTRAINT "ServiceAccountToken_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
