CREATE TABLE IF NOT EXISTS "phone_identities" (
    "id" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "lastInboundAt" TIMESTAMP(3),
    "outboundSinceInbound" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "phone_identities_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "phone_channels" (
    "id" TEXT NOT NULL,
    "providerGroupId" TEXT NOT NULL,
    "name" TEXT,
    "introPostedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "phone_channels_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "phone_channel_members" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "identityId" TEXT,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "phone_channel_members_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "phone_outbound" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "toNumber" TEXT,
    "providerGroupId" TEXT,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "providerHandle" TEXT,
    "sourceMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "phone_outbound_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "phone_identities_phoneE164_key" ON "phone_identities"("phoneE164");
CREATE UNIQUE INDEX IF NOT EXISTS "phone_identities_botId_key" ON "phone_identities"("botId");
CREATE INDEX IF NOT EXISTS "phone_identities_userId_idx" ON "phone_identities"("userId");

CREATE UNIQUE INDEX IF NOT EXISTS "phone_channels_providerGroupId_key" ON "phone_channels"("providerGroupId");

CREATE UNIQUE INDEX IF NOT EXISTS "phone_channel_members_channelId_phoneE164_key" ON "phone_channel_members"("channelId", "phoneE164");
CREATE INDEX IF NOT EXISTS "phone_channel_members_identityId_idx" ON "phone_channel_members"("identityId");

CREATE UNIQUE INDEX IF NOT EXISTS "phone_outbound_idempotencyKey_key" ON "phone_outbound"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "phone_outbound_status_idx" ON "phone_outbound"("status");

ALTER TABLE "phone_channel_members"
    ADD CONSTRAINT "phone_channel_members_channelId_fkey"
    FOREIGN KEY ("channelId") REFERENCES "phone_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
