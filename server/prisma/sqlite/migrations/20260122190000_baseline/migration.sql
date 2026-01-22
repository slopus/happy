-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "publicKey" TEXT NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "feedSeq" BIGINT NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "settings" TEXT,
    "settingsVersion" INTEGER NOT NULL DEFAULT 0,
    "githubUserId" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "username" TEXT,
    "avatar" JSONB,
    CONSTRAINT "Account_githubUserId_fkey" FOREIGN KEY ("githubUserId") REFERENCES "GithubUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TerminalAuthRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "publicKey" TEXT NOT NULL,
    "supportsV2" BOOLEAN NOT NULL DEFAULT false,
    "response" TEXT,
    "responseAccountId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TerminalAuthRequest_responseAccountId_fkey" FOREIGN KEY ("responseAccountId") REFERENCES "Account" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AccountAuthRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "publicKey" TEXT NOT NULL,
    "response" TEXT,
    "responseAccountId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AccountAuthRequest_responseAccountId_fkey" FOREIGN KEY ("responseAccountId") REFERENCES "Account" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AccountPushToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AccountPushToken_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tag" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "metadata" TEXT NOT NULL,
    "metadataVersion" INTEGER NOT NULL DEFAULT 0,
    "agentState" TEXT,
    "agentStateVersion" INTEGER NOT NULL DEFAULT 0,
    "dataEncryptionKey" BLOB,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastActiveAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Session_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SessionMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "localId" TEXT,
    "seq" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SessionMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GithubUser" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "profile" JSONB NOT NULL,
    "token" BLOB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GithubOrganization" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "profile" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GlobalLock" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "RepeatKey" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SimpleCache" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "UsageReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "sessionId" TEXT,
    "data" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UsageReport_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "UsageReport_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Machine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "metadata" TEXT NOT NULL,
    "metadataVersion" INTEGER NOT NULL DEFAULT 0,
    "daemonState" TEXT,
    "daemonStateVersion" INTEGER NOT NULL DEFAULT 0,
    "dataEncryptionKey" BLOB,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastActiveAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Machine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UploadedFile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "thumbhash" TEXT,
    "reuseKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UploadedFile_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ServiceAccountToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "token" BLOB NOT NULL,
    "metadata" JSONB,
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ServiceAccountToken_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Artifact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "header" BLOB NOT NULL,
    "headerVersion" INTEGER NOT NULL DEFAULT 0,
    "body" BLOB NOT NULL,
    "bodyVersion" INTEGER NOT NULL DEFAULT 0,
    "dataEncryptionKey" BLOB NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Artifact_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AccessKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "dataVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AccessKey_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AccessKey_accountId_machineId_fkey" FOREIGN KEY ("accountId", "machineId") REFERENCES "Machine" ("accountId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AccessKey_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UserRelationship" (
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "acceptedAt" DATETIME,
    "lastNotifiedAt" DATETIME,

    PRIMARY KEY ("fromUserId", "toUserId"),
    CONSTRAINT "UserRelationship_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "UserRelationship_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UserFeedItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "counter" BIGINT NOT NULL,
    "repeatKey" TEXT,
    "body" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UserFeedItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UserKVStore" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" BLOB,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UserKVStore_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Account_publicKey_key" ON "Account"("publicKey");

-- CreateIndex
CREATE UNIQUE INDEX "Account_githubUserId_key" ON "Account"("githubUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_username_key" ON "Account"("username");

-- CreateIndex
CREATE UNIQUE INDEX "TerminalAuthRequest_publicKey_key" ON "TerminalAuthRequest"("publicKey");

-- CreateIndex
CREATE UNIQUE INDEX "AccountAuthRequest_publicKey_key" ON "AccountAuthRequest"("publicKey");

-- CreateIndex
CREATE UNIQUE INDEX "AccountPushToken_accountId_token_key" ON "AccountPushToken"("accountId", "token");

-- CreateIndex
CREATE INDEX "Session_accountId_updatedAt_idx" ON "Session"("accountId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Session_accountId_tag_key" ON "Session"("accountId", "tag");

-- CreateIndex
CREATE INDEX "SessionMessage_sessionId_seq_idx" ON "SessionMessage"("sessionId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "SessionMessage_sessionId_localId_key" ON "SessionMessage"("sessionId", "localId");

-- CreateIndex
CREATE INDEX "UsageReport_accountId_idx" ON "UsageReport"("accountId");

-- CreateIndex
CREATE INDEX "UsageReport_sessionId_idx" ON "UsageReport"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "UsageReport_accountId_sessionId_key_key" ON "UsageReport"("accountId", "sessionId", "key");

-- CreateIndex
CREATE INDEX "Machine_accountId_idx" ON "Machine"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "Machine_accountId_id_key" ON "Machine"("accountId", "id");

-- CreateIndex
CREATE INDEX "UploadedFile_accountId_idx" ON "UploadedFile"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "UploadedFile_accountId_path_key" ON "UploadedFile"("accountId", "path");

-- CreateIndex
CREATE INDEX "ServiceAccountToken_accountId_idx" ON "ServiceAccountToken"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceAccountToken_accountId_vendor_key" ON "ServiceAccountToken"("accountId", "vendor");

-- CreateIndex
CREATE INDEX "Artifact_accountId_idx" ON "Artifact"("accountId");

-- CreateIndex
CREATE INDEX "Artifact_accountId_updatedAt_idx" ON "Artifact"("accountId", "updatedAt");

-- CreateIndex
CREATE INDEX "AccessKey_accountId_idx" ON "AccessKey"("accountId");

-- CreateIndex
CREATE INDEX "AccessKey_sessionId_idx" ON "AccessKey"("sessionId");

-- CreateIndex
CREATE INDEX "AccessKey_machineId_idx" ON "AccessKey"("machineId");

-- CreateIndex
CREATE UNIQUE INDEX "AccessKey_accountId_machineId_sessionId_key" ON "AccessKey"("accountId", "machineId", "sessionId");

-- CreateIndex
CREATE INDEX "UserRelationship_toUserId_status_idx" ON "UserRelationship"("toUserId", "status");

-- CreateIndex
CREATE INDEX "UserRelationship_fromUserId_status_idx" ON "UserRelationship"("fromUserId", "status");

-- CreateIndex
CREATE INDEX "UserFeedItem_userId_counter_idx" ON "UserFeedItem"("userId", "counter");

-- CreateIndex
CREATE UNIQUE INDEX "UserFeedItem_userId_counter_key" ON "UserFeedItem"("userId", "counter");

-- CreateIndex
CREATE UNIQUE INDEX "UserFeedItem_userId_repeatKey_key" ON "UserFeedItem"("userId", "repeatKey");

-- CreateIndex
CREATE INDEX "UserKVStore_accountId_idx" ON "UserKVStore"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "UserKVStore_accountId_key_key" ON "UserKVStore"("accountId", "key");

