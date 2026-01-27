-- This feature set has not been deployed yet, so we can safely reset public-share rows
-- while switching from storing plaintext bearer tokens to storing token hashes.

-- AlterTable
ALTER TABLE "Account"
ADD COLUMN     "contentPublicKey" BYTEA,
ADD COLUMN     "contentPublicKeySig" BYTEA;

-- Reset public-share data (token is a bearer secret)
DELETE FROM "PublicShareAccessLog";
DELETE FROM "PublicShareBlockedUser";
DELETE FROM "PublicSessionShare";

-- Drop legacy token indexes before dropping the column
DROP INDEX IF EXISTS "PublicSessionShare_token_key";
DROP INDEX IF EXISTS "PublicSessionShare_token_idx";

-- AlterTable
ALTER TABLE "PublicSessionShare"
DROP COLUMN "token",
ADD COLUMN     "tokenHash" BYTEA NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "PublicSessionShare_tokenHash_key" ON "PublicSessionShare"("tokenHash");
CREATE INDEX "PublicSessionShare_tokenHash_idx" ON "PublicSessionShare"("tokenHash");

