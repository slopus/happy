-- Phone surface → multi-provider messaging surface. Sendblue rows are
-- preserved under provider 'sendblue'; conversation addressing moves to
-- opaque provider thread ids, so per-vendor columns collapse.

-- Identities: one (provider, address) per person, DM thread learned on inbound.
ALTER TABLE "phone_identities" RENAME TO "messaging_identities";
ALTER TABLE "messaging_identities" RENAME COLUMN "phoneE164" TO "address";
ALTER TABLE "messaging_identities" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'sendblue';
-- The default only backfills the pre-existing sendblue rows; application code
-- always writes provider explicitly.
ALTER TABLE "messaging_identities" ALTER COLUMN "provider" DROP DEFAULT;
ALTER TABLE "messaging_identities" ADD COLUMN "dmThreadId" TEXT;
ALTER INDEX "phone_identities_pkey" RENAME TO "messaging_identities_pkey";
ALTER INDEX "phone_identities_botId_key" RENAME TO "messaging_identities_botId_key";
ALTER INDEX "phone_identities_userId_idx" RENAME TO "messaging_identities_userId_idx";
DROP INDEX "phone_identities_phoneE164_key";
CREATE UNIQUE INDEX "messaging_identities_provider_address_key"
    ON "messaging_identities"("provider", "address");
ALTER TABLE "messaging_identities"
    RENAME CONSTRAINT "phone_identities_spaceId_fkey" TO "messaging_identities_spaceId_fkey";

-- Channels: keyed by provider thread id. Legacy sendblue group ids cannot be
-- re-encoded into thread ids in SQL; prefix them so the next inbound group
-- message recreates the channel and restarts its invite cycle cleanly.
ALTER TABLE "phone_channels" RENAME TO "messaging_channels";
ALTER TABLE "messaging_channels" RENAME COLUMN "providerGroupId" TO "threadId";
ALTER TABLE "messaging_channels" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'sendblue';
ALTER TABLE "messaging_channels" ALTER COLUMN "provider" DROP DEFAULT;
UPDATE "messaging_channels" SET "threadId" = 'legacy:' || "threadId";
ALTER INDEX "phone_channels_pkey" RENAME TO "messaging_channels_pkey";
ALTER INDEX "phone_channels_providerGroupId_key" RENAME TO "messaging_channels_threadId_key";

ALTER TABLE "phone_channel_members" RENAME TO "messaging_channel_members";
ALTER TABLE "messaging_channel_members" RENAME COLUMN "phoneE164" TO "address";
ALTER INDEX "phone_channel_members_pkey" RENAME TO "messaging_channel_members_pkey";
ALTER INDEX "phone_channel_members_channelId_phoneE164_key"
    RENAME TO "messaging_channel_members_channelId_address_key";
ALTER INDEX "phone_channel_members_identityId_idx"
    RENAME TO "messaging_channel_members_identityId_idx";
ALTER TABLE "messaging_channel_members"
    RENAME CONSTRAINT "phone_channel_members_channelId_fkey"
    TO "messaging_channel_members_channelId_fkey";
-- Close out the retired channels' memberships too. A prefixed channel can
-- never receive traffic again, so a lingering 'approved' row would answer the
-- owner's next LEAVE command instead of their real group, and a lingering
-- 'invited' row would sit unanswerable in the web list. The next inbound group
-- message rebuilds membership under the real thread id.
UPDATE "messaging_channel_members" m
    SET "status" = 'left'
    FROM "messaging_channels" c
    WHERE m."channelId" = c."id"
      AND c."threadId" LIKE 'legacy:%'
      AND m."status" IN ('invited', 'approved');

-- Outbox: DM rows resolve threads through the identity; group rows carry the
-- provider thread id. Map pending DMs onto identities, then fail only rows
-- that still cannot be addressed (no identityId and no remappable group
-- threadId). Identity-backed DMs stay pending so in-flight YES/NO replies
-- and invites drain after deploy.
ALTER TABLE "phone_outbound" RENAME TO "messaging_outbound";
ALTER TABLE "messaging_outbound" ADD COLUMN "identityId" TEXT;
ALTER TABLE "messaging_outbound" ADD COLUMN "threadId" TEXT;
UPDATE "messaging_outbound" o
    SET "identityId" = i."id"
    FROM "messaging_identities" i
    WHERE o."toNumber" IS NOT NULL AND i."provider" = 'sendblue' AND i."address" = o."toNumber";
-- Legacy sendblue group ids cannot be re-encoded into Chat SDK thread ids in
-- SQL, so providerGroupId never becomes a remappable threadId here.
UPDATE "messaging_outbound"
    SET "status" = 'failed'
    WHERE "status" = 'pending'
      AND "identityId" IS NULL
      AND "threadId" IS NULL;
ALTER TABLE "messaging_outbound" DROP COLUMN "toNumber";
ALTER TABLE "messaging_outbound" DROP COLUMN "providerGroupId";
ALTER INDEX "phone_outbound_pkey" RENAME TO "messaging_outbound_pkey";
ALTER INDEX "phone_outbound_idempotencyKey_key" RENAME TO "messaging_outbound_idempotencyKey_key";
ALTER INDEX "phone_outbound_status_nextAttemptAt_idx"
    RENAME TO "messaging_outbound_status_nextAttemptAt_idx";

-- Runs and stored message blocks move to the neutral vocabulary. Replayed
-- run.started event payloads carry the trigger too, so they migrate as well.
UPDATE "runs" SET "trigger" = 'messaging' WHERE "trigger" = 'phone';
UPDATE "events"
    SET "payload" = jsonb_set("payload", '{trigger}', '"messaging"')
    WHERE "payload" ->> 'trigger' = 'phone';
UPDATE "messages"
    SET "blocks" = (
        SELECT jsonb_agg(
            CASE
                WHEN block ->> 'kind' = 'phone_channel_message' THEN
                    (block - 'fromNumber')
                        || jsonb_build_object(
                            'kind', 'channel_message',
                            'provider', 'sendblue',
                            'fromAddress', block -> 'fromNumber'
                        )
                ELSE block
            END
            ORDER BY position
        )
        FROM jsonb_array_elements("blocks") WITH ORDINALITY AS entry(block, position)
    )
    WHERE "blocks"::text LIKE '%phone_channel_message%';

-- Web-issued linking codes: bind a chat address to an existing user + bot.
CREATE TABLE "messaging_link_codes" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messaging_link_codes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "messaging_link_codes_code_key" ON "messaging_link_codes"("code");
CREATE INDEX "messaging_link_codes_userId_idx" ON "messaging_link_codes"("userId");
