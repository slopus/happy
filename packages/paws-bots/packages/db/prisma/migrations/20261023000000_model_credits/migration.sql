ALTER TABLE "billing_accounts" ADD COLUMN "creditAmountCents" INTEGER;
CREATE TABLE "model_credit_accounts" (
 "organizationId" TEXT PRIMARY KEY REFERENCES "organization"("id") ON DELETE CASCADE,
 "mode" TEXT CHECK ("mode" IN ('byok', 'credits')),
 "balanceMicros" BIGINT NOT NULL DEFAULT 0,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "model_credit_entries" (
 "id" TEXT PRIMARY KEY,
 "organizationId" TEXT NOT NULL REFERENCES "model_credit_accounts"("organizationId") ON DELETE CASCADE,
 "source" TEXT NOT NULL UNIQUE,
 "amountMicros" BIGINT NOT NULL,
 "pending" BOOLEAN NOT NULL DEFAULT false,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "model_credit_entries_organizationId_createdAt_idx" ON "model_credit_entries"("organizationId", "createdAt");
GRANT SELECT, INSERT, UPDATE, DELETE ON "model_credit_accounts", "model_credit_entries" TO rakazo_app;
