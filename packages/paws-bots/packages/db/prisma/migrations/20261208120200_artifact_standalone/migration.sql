-- Additive: files strangers email stay out of same-name version families.
ALTER TABLE "artifacts" ADD COLUMN "standalone" BOOLEAN NOT NULL DEFAULT false;
