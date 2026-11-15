-- Additive: the previous release never reads these tables.
CREATE TABLE "spending_limits" (
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "spending_limits_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "spending_limits" ADD CONSTRAINT "spending_limits_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "operationKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "site" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payments_operationKey_key" ON "payments"("operationKey");
CREATE INDEX "payments_userId_createdAt_idx" ON "payments"("userId", "createdAt");

ALTER TABLE "payments" ADD CONSTRAINT "payments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A user's own, in every Space, as payment_wallets.
ALTER TABLE "spending_limits" ENABLE ROW LEVEL SECURITY;
CREATE POLICY spending_limits_tenant ON "spending_limits"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY spending_limits_system ON "spending_limits"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;
CREATE POLICY payments_tenant ON "payments"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY payments_system ON "payments"
  USING ((SELECT app_rls_bypass()));

-- Wallet purchases made before the limit existed count too, unless they were never paid. The poller
-- releases one that is later denied or expires, by the same operation key.
INSERT INTO "payments" ("id", "operationKey", "userId", "spaceId", "botId", "threadId", "site", "amount", "currency", "createdAt")
SELECT gen_random_uuid()::text, p."operationKey", p."userId", p."spaceId", p."botId", p."threadId",
       coalesce(substring(p."merchantUrl" from '^https?://([^/?#]+)'), ''), p."amount", p."currency", p."createdAt"
FROM "purchases" p
WHERE p."status" NOT IN ('denied', 'expired', 'canceled', 'failed')
  AND EXISTS (SELECT 1 FROM "user" u WHERE u."id" = p."userId")
ON CONFLICT ("operationKey") DO NOTHING;
