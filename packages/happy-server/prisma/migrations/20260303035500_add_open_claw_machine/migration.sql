-- CreateTable
CREATE TABLE "OpenClawMachine" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "happyMachineId" TEXT,
    "directConfig" TEXT,
    "metadata" TEXT NOT NULL,
    "pairingData" TEXT,
    "dataEncryptionKey" BYTEA,
    "metadataVersion" INTEGER NOT NULL DEFAULT 0,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpenClawMachine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OpenClawMachine_accountId_idx" ON "OpenClawMachine"("accountId");

-- AddForeignKey
ALTER TABLE "OpenClawMachine" ADD CONSTRAINT "OpenClawMachine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
