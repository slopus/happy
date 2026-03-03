-- CreateEnum
CREATE TYPE "ShareAccessLevel" AS ENUM ('view', 'edit', 'admin');

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "contentPublicKey" BYTEA,
ADD COLUMN     "contentPublicKeySig" BYTEA;

-- CreateTable
CREATE TABLE "SessionShare" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sharedByUserId" TEXT NOT NULL,
    "sharedWithUserId" TEXT NOT NULL,
    "accessLevel" "ShareAccessLevel" NOT NULL DEFAULT 'view',
    "encryptedDataKey" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SessionShare_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublicSessionShare" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "tokenHash" BYTEA NOT NULL,
    "encryptedDataKey" BYTEA NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "maxUses" INTEGER,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "isConsentRequired" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublicSessionShare_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionShareAccessLog" (
    "id" TEXT NOT NULL,
    "shareId" TEXT NOT NULL,
    "userId" TEXT,
    "accessedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionShareAccessLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublicShareAccessLog" (
    "id" TEXT NOT NULL,
    "publicShareId" TEXT NOT NULL,
    "userId" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "accessedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PublicShareAccessLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublicShareBlockedUser" (
    "id" TEXT NOT NULL,
    "publicShareId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT,
    "blockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PublicShareBlockedUser_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SessionShare_sharedWithUserId_idx" ON "SessionShare"("sharedWithUserId");

-- CreateIndex
CREATE INDEX "SessionShare_sharedByUserId_idx" ON "SessionShare"("sharedByUserId");

-- CreateIndex
CREATE INDEX "SessionShare_sessionId_idx" ON "SessionShare"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionShare_sessionId_sharedWithUserId_key" ON "SessionShare"("sessionId", "sharedWithUserId");

-- CreateIndex
CREATE UNIQUE INDEX "PublicSessionShare_sessionId_key" ON "PublicSessionShare"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "PublicSessionShare_tokenHash_key" ON "PublicSessionShare"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "PublicShareBlockedUser_publicShareId_userId_key" ON "PublicShareBlockedUser"("publicShareId", "userId");

-- AddForeignKey
ALTER TABLE "SessionShare" ADD CONSTRAINT "SessionShare_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionShare" ADD CONSTRAINT "SessionShare_sharedByUserId_fkey" FOREIGN KEY ("sharedByUserId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionShare" ADD CONSTRAINT "SessionShare_sharedWithUserId_fkey" FOREIGN KEY ("sharedWithUserId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublicSessionShare" ADD CONSTRAINT "PublicSessionShare_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublicSessionShare" ADD CONSTRAINT "PublicSessionShare_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionShareAccessLog" ADD CONSTRAINT "SessionShareAccessLog_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES "SessionShare"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublicShareAccessLog" ADD CONSTRAINT "PublicShareAccessLog_publicShareId_fkey" FOREIGN KEY ("publicShareId") REFERENCES "PublicSessionShare"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublicShareBlockedUser" ADD CONSTRAINT "PublicShareBlockedUser_publicShareId_fkey" FOREIGN KEY ("publicShareId") REFERENCES "PublicSessionShare"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublicShareBlockedUser" ADD CONSTRAINT "PublicShareBlockedUser_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
