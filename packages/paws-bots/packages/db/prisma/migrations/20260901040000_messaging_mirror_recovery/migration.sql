ALTER TABLE "runs" ADD COLUMN "messagingMirroredAt" TIMESTAMP(3);

-- Existing completed messaging runs predate the recovery marker and must not
-- be replayed on deploy. Include the legacy trigger because this migration
-- sorts before the phone-to-messaging vocabulary migration on a fresh database.
UPDATE "runs"
SET "messagingMirroredAt" = COALESCE("completedAt", "updatedAt")
WHERE "trigger" IN ('phone', 'messaging') AND "status" = 'completed';
