-- Existing rows retain their current colour/shape/photo and original renderer.
ALTER TABLE "bots" ADD COLUMN "avatarSet" TEXT NOT NULL DEFAULT 'organic';
-- Only subsequent inserts use the new set unless explicitly choosing the original.
ALTER TABLE "bots" ALTER COLUMN "avatarSet" SET DEFAULT 'rakazo';
