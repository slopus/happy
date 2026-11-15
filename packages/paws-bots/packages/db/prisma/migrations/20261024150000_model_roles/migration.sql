CREATE TABLE "space_model_role_choices" (
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "provider" TEXT NOT NULL,
  "modelId" TEXT NOT NULL,
  "thinkingLevel" TEXT,
  CONSTRAINT "space_model_role_choices_pkey" PRIMARY KEY ("spaceId", "userId", "role", "position"),
  CONSTRAINT "space_model_role_choices_spaceId_userId_fkey" FOREIGN KEY ("spaceId", "userId")
    REFERENCES "space_members"("spaceId", "userId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "space_model_role_choices_spaceId_userId_role_provider_modelId_key"
  ON "space_model_role_choices"("spaceId", "userId", "role", "provider", "modelId");
ALTER TABLE "space_model_role_choices" ENABLE ROW LEVEL SECURITY;
CREATE POLICY space_model_role_choices_tenant ON "space_model_role_choices"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
     AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY space_model_role_choices_system ON "space_model_role_choices"
  USING (current_setting('app.rls_bypass', true) = 'on');
GRANT SELECT, INSERT, UPDATE, DELETE ON "space_model_role_choices" TO rakazo_app;

-- The main model moves here from the default preference and space_backup_models, which
-- this release keeps writing for the previous one. A default without a usable model id
-- has nothing to copy and keeps following the deployment default.
INSERT INTO "space_model_role_choices"
  ("spaceId", "userId", "role", "position", "provider", "modelId", "thinkingLevel")
SELECT DISTINCT ON (p."spaceId", p."userId") p."spaceId", p."userId", 'main', 0,
  CASE WHEN c."provider" = 'azure-openai-responses' THEN 'azure' ELSE c."provider" END,
  btrim(p."modelId"), p."thinkingLevel"
FROM "space_model_preferences" p
JOIN "user_model_credentials" c ON c."id" = p."credentialId" AND c."userId" = p."userId"
WHERE p."isDefault"
  AND btrim(p."modelId") NOT IN ('', 'null', 'undefined')
-- Earlier releases read the newest default when more than one is marked.
ORDER BY p."spaceId", p."userId", p."updatedAt" DESC, p."id" DESC
ON CONFLICT DO NOTHING;

INSERT INTO "space_model_role_choices"
  ("spaceId", "userId", "role", "position", "provider", "modelId")
SELECT b."spaceId", b."userId", 'main',
  (row_number() OVER (PARTITION BY b."spaceId", b."userId" ORDER BY b."position"))::INTEGER,
  CASE WHEN b."provider" = 'azure-openai-responses' THEN 'azure' ELSE b."provider" END,
  b."modelId"
FROM "space_backup_models" b
WHERE NOT EXISTS (
  -- The main model already runs first, so a matching fallback would never be tried.
  SELECT 1 FROM "space_model_role_choices" r
  WHERE r."spaceId" = b."spaceId" AND r."userId" = b."userId" AND r."role" = 'main'
    AND r."position" = 0
    AND r."provider" = CASE WHEN b."provider" = 'azure-openai-responses' THEN 'azure' ELSE b."provider" END
    AND r."modelId" = b."modelId"
)
ON CONFLICT DO NOTHING;
