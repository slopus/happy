-- Additive: older releases never read or write it.
ALTER TABLE "action_auto_review_preferences" ADD COLUMN "skipApprovals" BOOLEAN NOT NULL DEFAULT false;
