-- CreateTable
CREATE TABLE "AccountAuthRequest" (
    "id" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "response" TEXT,
    "responseAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountAuthRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountAuthRequest_publicKey_key" ON "AccountAuthRequest"("publicKey");

-- AddForeignKey
ALTER TABLE "AccountAuthRequest" ADD CONSTRAINT "AccountAuthRequest_responseAccountId_fkey" FOREIGN KEY ("responseAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
