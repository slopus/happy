-- Nullable and additive: the previous release keeps working without it.
ALTER TABLE "runs" ADD COLUMN "promptVersion" TEXT;
