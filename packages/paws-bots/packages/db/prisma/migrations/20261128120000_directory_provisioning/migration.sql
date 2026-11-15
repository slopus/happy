-- Additive: older releases never read or write these. The SCIM tables are auth tables like
-- session and account: only the authentication routes, which run as system, touch them.
-- AlterTable
ALTER TABLE "user" ADD COLUMN     "deactivatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "scim_connection_bindings" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "connectionKey" TEXT NOT NULL,
    "provisioningDomainId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "decommissionedAt" TIMESTAMP(3),
    "decommissionStatus" TEXT NOT NULL DEFAULT 'active',
    "decommissionCursorUserId" TEXT,
    "decommissionReconciledUserCount" INTEGER NOT NULL DEFAULT 0,
    "decommissionBatchCount" INTEGER NOT NULL DEFAULT 0,
    "decommissionRevision" INTEGER NOT NULL DEFAULT 0,
    "decommissionCompletedAt" TIMESTAMP(3),
    "decommissionLeaseId" TEXT,
    "decommissionLeaseExpiresAt" TIMESTAMP(3),

    CONSTRAINT "scim_connection_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scim_identity_tombstones" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "provisioningDomainId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "externalIdKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "profile" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scim_identity_tombstones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scim_subjects" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "profileSourceId" TEXT,
    "revision" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scim_subjects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scim_users" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "provisioningDomainId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectionUserKey" TEXT NOT NULL,
    "userName" TEXT NOT NULL,
    "userNameKey" TEXT NOT NULL,
    "primaryEmail" TEXT NOT NULL,
    "workEmailValueIndex" TEXT NOT NULL,
    "emailValueIndex" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "formattedName" TEXT NOT NULL,
    "givenName" TEXT,
    "familyName" TEXT,
    "serializedEmails" TEXT NOT NULL,
    "serializedAttributes" TEXT,
    "externalId" TEXT,
    "externalIdKey" TEXT,
    "active" BOOLEAN NOT NULL,
    "orderKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scim_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scim_projection_grants" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "provisioningDomainId" TEXT NOT NULL,
    "scimUserId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceValue" TEXT,
    "role" TEXT NOT NULL,
    "grantKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scim_projection_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scim_groups" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "provisioningDomainId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "displayName" TEXT NOT NULL,
    "displayNameKey" TEXT NOT NULL,
    "externalId" TEXT,
    "externalIdKey" TEXT,
    "orderKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scim_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scim_group_members" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "scimUserId" TEXT NOT NULL,
    "membershipKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scim_group_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "scim_connection_bindings_connectionKey_key" ON "scim_connection_bindings"("connectionKey");

-- CreateIndex
CREATE INDEX "scim_connection_bindings_connectionId_idx" ON "scim_connection_bindings"("connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "scim_identity_tombstones_externalIdKey_key" ON "scim_identity_tombstones"("externalIdKey");

-- CreateIndex
CREATE INDEX "scim_identity_tombstones_connectionId_idx" ON "scim_identity_tombstones"("connectionId");

-- CreateIndex
CREATE INDEX "scim_identity_tombstones_provisioningDomainId_idx" ON "scim_identity_tombstones"("provisioningDomainId");

-- CreateIndex
CREATE INDEX "scim_identity_tombstones_userId_idx" ON "scim_identity_tombstones"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "scim_subjects_userId_key" ON "scim_subjects"("userId");

-- CreateIndex
CREATE INDEX "scim_subjects_profileSourceId_idx" ON "scim_subjects"("profileSourceId");

-- CreateIndex
CREATE UNIQUE INDEX "scim_users_connectionUserKey_key" ON "scim_users"("connectionUserKey");

-- CreateIndex
CREATE UNIQUE INDEX "scim_users_userNameKey_key" ON "scim_users"("userNameKey");

-- CreateIndex
CREATE UNIQUE INDEX "scim_users_externalIdKey_key" ON "scim_users"("externalIdKey");

-- CreateIndex
CREATE UNIQUE INDEX "scim_users_orderKey_key" ON "scim_users"("orderKey");

-- CreateIndex
CREATE INDEX "scim_users_connectionId_idx" ON "scim_users"("connectionId");

-- CreateIndex
CREATE INDEX "scim_users_provisioningDomainId_idx" ON "scim_users"("provisioningDomainId");

-- CreateIndex
CREATE INDEX "scim_users_userId_idx" ON "scim_users"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "scim_projection_grants_grantKey_key" ON "scim_projection_grants"("grantKey");

-- CreateIndex
CREATE INDEX "scim_projection_grants_connectionId_idx" ON "scim_projection_grants"("connectionId");

-- CreateIndex
CREATE INDEX "scim_projection_grants_provisioningDomainId_idx" ON "scim_projection_grants"("provisioningDomainId");

-- CreateIndex
CREATE INDEX "scim_projection_grants_scimUserId_idx" ON "scim_projection_grants"("scimUserId");

-- CreateIndex
CREATE INDEX "scim_projection_grants_userId_idx" ON "scim_projection_grants"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "scim_groups_displayNameKey_key" ON "scim_groups"("displayNameKey");

-- CreateIndex
CREATE UNIQUE INDEX "scim_groups_externalIdKey_key" ON "scim_groups"("externalIdKey");

-- CreateIndex
CREATE UNIQUE INDEX "scim_groups_orderKey_key" ON "scim_groups"("orderKey");

-- CreateIndex
CREATE INDEX "scim_groups_connectionId_idx" ON "scim_groups"("connectionId");

-- CreateIndex
CREATE INDEX "scim_groups_provisioningDomainId_idx" ON "scim_groups"("provisioningDomainId");

-- CreateIndex
CREATE UNIQUE INDEX "scim_group_members_membershipKey_key" ON "scim_group_members"("membershipKey");

-- CreateIndex
CREATE INDEX "scim_group_members_connectionId_idx" ON "scim_group_members"("connectionId");

-- CreateIndex
CREATE INDEX "scim_group_members_groupId_idx" ON "scim_group_members"("groupId");

-- CreateIndex
CREATE INDEX "scim_group_members_scimUserId_idx" ON "scim_group_members"("scimUserId");

-- AddForeignKey
ALTER TABLE "scim_identity_tombstones" ADD CONSTRAINT "scim_identity_tombstones_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scim_subjects" ADD CONSTRAINT "scim_subjects_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scim_users" ADD CONSTRAINT "scim_users_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scim_projection_grants" ADD CONSTRAINT "scim_projection_grants_scimUserId_fkey" FOREIGN KEY ("scimUserId") REFERENCES "scim_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scim_projection_grants" ADD CONSTRAINT "scim_projection_grants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scim_group_members" ADD CONSTRAINT "scim_group_members_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "scim_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scim_group_members" ADD CONSTRAINT "scim_group_members_scimUserId_fkey" FOREIGN KEY ("scimUserId") REFERENCES "scim_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

