-- Additive: older releases never read or write them.
ALTER TABLE "billing_accounts" ADD COLUMN "checkoutLeaseId" TEXT,
ADD COLUMN "checkoutLeaseExpiresAt" TIMESTAMP(3);
