-- The previous release no longer reads these. bots.title, bots.selfUpdateInstructions,
-- referrals.rewardKind and referrals.declinedAt are dropped by a later migration.
DROP TABLE "billing_card_fingerprints";

ALTER TABLE "referrals" DROP COLUMN "createdAt";

-- Decisions the release before last saved only in the old columns while it overlapped the last one.
UPDATE "referrals"
SET "outcome" = COALESCE("rewardKind", CASE WHEN "declinedAt" IS NOT NULL THEN 'declined' END)
WHERE "outcome" IS NULL;
