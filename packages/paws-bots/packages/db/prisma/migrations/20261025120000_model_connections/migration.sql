-- A role row may pin the connection it runs on, so the same model can run on two accounts.
-- Additive: the previous release keeps writing rows without a connection, which still
-- resolve by provider and model.
ALTER TABLE "space_model_role_choices" ADD COLUMN "credentialId" TEXT;

-- A row cannot outlive its connection: running it elsewhere would bill another account.
ALTER TABLE "space_model_role_choices"
  ADD CONSTRAINT "space_model_role_choices_credentialId_userId_fkey"
  FOREIGN KEY ("credentialId", "userId") REFERENCES "user_model_credentials"("id", "userId")
  ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "space_model_role_choices_credentialId_userId_idx"
  ON "space_model_role_choices"("credentialId", "userId");

-- Each model once per connection. The previous release only writes rows without a
-- connection, which this index still keeps unique, so it is replaced before the old one goes.
CREATE UNIQUE INDEX "space_model_role_choices_model_connection_key"
  ON "space_model_role_choices"("spaceId", "userId", "role", "provider", "modelId", "credentialId")
  NULLS NOT DISTINCT;
DROP INDEX "space_model_role_choices_spaceId_userId_role_provider_modelId_key";

-- Every account had one connection per provider until now, so existing rows run on it.
UPDATE "space_model_role_choices" r
SET "credentialId" = c."id"
FROM "user_model_credentials" c
WHERE r."credentialId" IS NULL
  AND c."userId" = r."userId"
  AND CASE WHEN c."provider" = 'azure-openai-responses' THEN 'azure' ELSE c."provider" END = r."provider"
  AND (
    SELECT count(*) FROM "user_model_credentials" o
    WHERE o."userId" = r."userId"
      AND CASE WHEN o."provider" = 'azure-openai-responses' THEN 'azure' ELSE o."provider" END = r."provider"
  ) = 1;
