-- Additive: both releases read and write rewardKind and declinedAt while they overlap; a later
-- migration drops them, referrals.createdAt and billing_card_fingerprints.
ALTER TABLE "referrals" ADD COLUMN "cardFingerprint" TEXT;
ALTER TABLE "referrals" ADD COLUMN "outcome" TEXT;

CREATE UNIQUE INDEX "referrals_cardFingerprint_key" ON "referrals"("cardFingerprint");

UPDATE "referrals"
SET "outcome" = COALESCE("rewardKind", CASE WHEN "declinedAt" IS NOT NULL THEN 'declined' END);

-- A card that already earned a reward cannot earn another. Each card goes to one referral, so
-- histories sharing a card cannot break the unique index.
UPDATE "referrals" r
SET "cardFingerprint" = card."fingerprint"
FROM (
  SELECT DISTINCT ON (f."fingerprint") f."fingerprint", f."organizationId"
  FROM "billing_card_fingerprints" f
  JOIN "referrals" rewarded ON rewarded."organizationId" = f."organizationId"
  WHERE rewarded."rewardKind" IS NOT NULL
  ORDER BY f."fingerprint", f."createdAt"
) card
WHERE r."organizationId" = card."organizationId";
