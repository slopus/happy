-- Additive: older releases never read or write it.
ALTER TABLE "runs" ADD COLUMN "groupReplyOptional" BOOLEAN NOT NULL DEFAULT false;
