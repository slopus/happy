-- The previous release no longer reads these.
ALTER TABLE "bots" DROP COLUMN "title";
ALTER TABLE "bots" DROP COLUMN "selfUpdateInstructions";

ALTER TABLE "referrals" DROP COLUMN "rewardKind";
ALTER TABLE "referrals" DROP COLUMN "declinedAt";
