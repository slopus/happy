-- Add capability ownership and expiry for login-free public session shares.
ALTER TABLE "PublicSessionShare"
    ALTER COLUMN "accountId" DROP NOT NULL,
    ALTER COLUMN "sessionId" DROP NOT NULL,
    ADD COLUMN "managementTokenHash" BYTEA,
    ADD COLUMN "createRequestId" TEXT,
    ADD COLUMN "sourceProvider" TEXT,
    ADD COLUMN "expiresAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "PublicSessionShare_managementTokenHash_key"
    ON "PublicSessionShare"("managementTokenHash");
CREATE UNIQUE INDEX "PublicSessionShare_createRequestId_key"
    ON "PublicSessionShare"("createRequestId");
CREATE INDEX "PublicSessionShare_expiresAt_idx"
    ON "PublicSessionShare"("expiresAt");

ALTER TABLE "PublicSessionShare"
    ADD CONSTRAINT "PublicSessionShare_owner_check" CHECK (
        ("accountId" IS NOT NULL AND "sessionId" IS NOT NULL AND "managementTokenHash" IS NULL)
        OR
        ("accountId" IS NULL AND "sessionId" IS NULL AND "managementTokenHash" IS NOT NULL)
    );

-- Attachment IDs are deterministic and may legitimately repeat in a new
-- generation of the same public link.
ALTER TABLE "PublicSessionShareAsset"
    DROP CONSTRAINT "PublicSessionShareAsset_pkey";
DROP INDEX "PublicSessionShareAsset_shareId_generation_id_key";
ALTER TABLE "PublicSessionShareAsset"
    ADD CONSTRAINT "PublicSessionShareAsset_pkey" PRIMARY KEY ("shareId", "generation", "id");
