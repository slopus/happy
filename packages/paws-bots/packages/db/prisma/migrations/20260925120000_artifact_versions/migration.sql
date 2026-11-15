ALTER TABLE "artifacts" ADD COLUMN "description" TEXT;

ALTER TABLE "artifacts" ADD COLUMN "rootArtifactId" TEXT;
ALTER TABLE "artifacts" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "artifacts"
  ADD CONSTRAINT "artifacts_rootArtifactId_fkey"
  FOREIGN KEY ("rootArtifactId") REFERENCES "artifacts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "artifacts_rootArtifactId_idx" ON "artifacts"("rootArtifactId");

-- Concurrent same-family publishes retry on this unique conflict.
CREATE UNIQUE INDEX "artifacts_family_version_key"
  ON "artifacts" (COALESCE("rootArtifactId", "id"), "version");
