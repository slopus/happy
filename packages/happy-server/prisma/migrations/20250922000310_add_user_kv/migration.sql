-- CreateTable
CREATE TABLE "UserKVStore" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" BYTEA,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserKVStore_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserKVStore_accountId_idx" ON "UserKVStore"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "UserKVStore_accountId_key_key" ON "UserKVStore"("accountId", "key");

-- AddForeignKey
ALTER TABLE "UserKVStore" ADD CONSTRAINT "UserKVStore_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
