-- CreateTable
CREATE TABLE "PublicSessionShare" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "snapshot" JSONB,
    "activeGeneration" TEXT,
    "publishedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lifecycleVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublicSessionShare_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublicSessionShareDraft" (
    "id" TEXT NOT NULL,
    "shareId" TEXT NOT NULL,
    "lifecycleVersion" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublicSessionShareDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublicSessionShareAsset" (
    "id" TEXT NOT NULL,
    "shareId" TEXT NOT NULL,
    "generation" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3),
    "storagePath" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PublicSessionShareAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PublicSessionShare_publicId_key" ON "PublicSessionShare"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "PublicSessionShare_sessionId_key" ON "PublicSessionShare"("sessionId");

-- CreateIndex
CREATE INDEX "PublicSessionShare_accountId_updatedAt_idx" ON "PublicSessionShare"("accountId", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "PublicSessionShareDraft_shareId_status_expiresAt_idx" ON "PublicSessionShareDraft"("shareId", "status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PublicSessionShareAsset_shareId_generation_id_key" ON "PublicSessionShareAsset"("shareId", "generation", "id");

-- CreateIndex
CREATE INDEX "PublicSessionShareAsset_shareId_generation_idx" ON "PublicSessionShareAsset"("shareId", "generation");

-- AddForeignKey
ALTER TABLE "PublicSessionShare" ADD CONSTRAINT "PublicSessionShare_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublicSessionShare" ADD CONSTRAINT "PublicSessionShare_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublicSessionShareDraft" ADD CONSTRAINT "PublicSessionShareDraft_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES "PublicSessionShare"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublicSessionShareAsset" ADD CONSTRAINT "PublicSessionShareAsset_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES "PublicSessionShare"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublicSessionShareAsset" ADD CONSTRAINT "PublicSessionShareAsset_generation_fkey" FOREIGN KEY ("generation") REFERENCES "PublicSessionShareDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
