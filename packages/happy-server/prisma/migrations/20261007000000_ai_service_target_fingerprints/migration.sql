-- Existing grants remain valid for their revision's default target only.
ALTER TABLE "AIServiceAuthorization" ADD COLUMN "targetFingerprints" JSONB;
