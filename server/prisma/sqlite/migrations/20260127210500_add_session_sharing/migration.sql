-- AlterTable
ALTER TABLE "Account" ADD COLUMN "contentPublicKey" BLOB;
ALTER TABLE "Account" ADD COLUMN "contentPublicKeySig" BLOB;

-- CreateTable
CREATE TABLE "SessionShare" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "sharedByUserId" TEXT NOT NULL,
    "sharedWithUserId" TEXT NOT NULL,
    "accessLevel" TEXT NOT NULL DEFAULT 'view',
    "encryptedDataKey" BLOB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SessionShare_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SessionShare_sharedByUserId_fkey" FOREIGN KEY ("sharedByUserId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SessionShare_sharedWithUserId_fkey" FOREIGN KEY ("sharedWithUserId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SessionShareAccessLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionShareId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    CONSTRAINT "SessionShareAccessLog_sessionShareId_fkey" FOREIGN KEY ("sessionShareId") REFERENCES "SessionShare" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SessionShareAccessLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PublicSessionShare" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "tokenHash" BLOB NOT NULL,
    "encryptedDataKey" BLOB NOT NULL,
    "expiresAt" DATETIME,
    "maxUses" INTEGER,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "isConsentRequired" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PublicSessionShare_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PublicSessionShare_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PublicShareAccessLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "publicShareId" TEXT NOT NULL,
    "userId" TEXT,
    "accessedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    CONSTRAINT "PublicShareAccessLog_publicShareId_fkey" FOREIGN KEY ("publicShareId") REFERENCES "PublicSessionShare" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PublicShareAccessLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Account" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PublicShareBlockedUser" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "publicShareId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "blockedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,
    CONSTRAINT "PublicShareBlockedUser_publicShareId_fkey" FOREIGN KEY ("publicShareId") REFERENCES "PublicSessionShare" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PublicShareBlockedUser_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
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
CREATE INDEX "SessionShareAccessLog_sessionShareId_idx" ON "SessionShareAccessLog"("sessionShareId");

-- CreateIndex
CREATE INDEX "SessionShareAccessLog_userId_idx" ON "SessionShareAccessLog"("userId");

-- CreateIndex
CREATE INDEX "SessionShareAccessLog_accessedAt_idx" ON "SessionShareAccessLog"("accessedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PublicSessionShare_sessionId_key" ON "PublicSessionShare"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "PublicSessionShare_tokenHash_key" ON "PublicSessionShare"("tokenHash");

-- CreateIndex
CREATE INDEX "PublicSessionShare_tokenHash_idx" ON "PublicSessionShare"("tokenHash");

-- CreateIndex
CREATE INDEX "PublicSessionShare_sessionId_idx" ON "PublicSessionShare"("sessionId");

-- CreateIndex
CREATE INDEX "PublicShareAccessLog_publicShareId_idx" ON "PublicShareAccessLog"("publicShareId");

-- CreateIndex
CREATE INDEX "PublicShareAccessLog_userId_idx" ON "PublicShareAccessLog"("userId");

-- CreateIndex
CREATE INDEX "PublicShareAccessLog_accessedAt_idx" ON "PublicShareAccessLog"("accessedAt");

-- CreateIndex
CREATE INDEX "PublicShareBlockedUser_publicShareId_idx" ON "PublicShareBlockedUser"("publicShareId");

-- CreateIndex
CREATE INDEX "PublicShareBlockedUser_userId_idx" ON "PublicShareBlockedUser"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PublicShareBlockedUser_publicShareId_userId_key" ON "PublicShareBlockedUser"("publicShareId", "userId");

