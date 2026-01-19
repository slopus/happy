-- CreateTable
CREATE TABLE "TerminalAuthRequest" (
    "id" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "response" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TerminalAuthRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TerminalAuthRequest_publicKey_key" ON "TerminalAuthRequest"("publicKey");
