-- Additive: the previous release never reads these columns. The own-key trial becomes one per
-- owner: a marker that free own-key days used it (they outlast the organization's rows), and a
-- hold an open checkout session takes on its owner while the session can still be paid. Owners
-- of live organizations that already had free days need no backfill: the trial check still
-- counts those organizations' rows.
ALTER TABLE "user" ADD COLUMN "byokTrialUsedAt" TIMESTAMP(3);
ALTER TABLE "user" ADD COLUMN "byokTrialCheckoutOrganizationId" TEXT;
ALTER TABLE "user" ADD COLUMN "byokTrialCheckoutExpiresAt" TIMESTAMP(3);
