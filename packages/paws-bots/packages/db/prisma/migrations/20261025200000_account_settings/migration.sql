-- Models, voice and confirmations become account-wide with an opt-in per-Space override.
-- Additive: the previous release keeps reading and writing the space tables, which stay
-- as each override's storage; a Space without an override row follows the account.

CREATE TABLE "space_setting_overrides" (
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "setting" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "space_setting_overrides_pkey" PRIMARY KEY ("spaceId", "userId", "setting"),
  CONSTRAINT "space_setting_overrides_spaceId_userId_fkey" FOREIGN KEY ("spaceId", "userId")
    REFERENCES "space_members"("spaceId", "userId") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "user_model_role_choices" (
  "userId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "provider" TEXT NOT NULL,
  "modelId" TEXT NOT NULL,
  "thinkingLevel" TEXT,
  "credentialId" TEXT,
  CONSTRAINT "user_model_role_choices_pkey" PRIMARY KEY ("userId", "role", "position"),
  CONSTRAINT "user_model_role_choices_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "user_model_role_choices_credentialId_userId_fkey" FOREIGN KEY ("credentialId", "userId")
    REFERENCES "user_model_credentials"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "user_model_role_choices_credentialId_userId_idx"
  ON "user_model_role_choices"("credentialId", "userId");
CREATE UNIQUE INDEX "user_model_role_choices_model_connection_key"
  ON "user_model_role_choices"("userId", "role", "provider", "modelId", "credentialId")
  NULLS NOT DISTINCT;

CREATE TABLE "user_model_preferences" (
  "userId" TEXT NOT NULL,
  "credentialId" TEXT NOT NULL,
  "modelId" TEXT,
  "thinkingLevel" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "user_model_preferences_pkey" PRIMARY KEY ("userId", "credentialId"),
  CONSTRAINT "user_model_preferences_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "user_model_preferences_credentialId_userId_fkey" FOREIGN KEY ("credentialId", "userId")
    REFERENCES "user_model_credentials"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "user_voice_preferences" (
  "userId" TEXT NOT NULL,
  "credentialId" TEXT NOT NULL,
  "voiceId" TEXT NOT NULL DEFAULT '',
  "speechModel" TEXT,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "user_voice_preferences_pkey" PRIMARY KEY ("userId", "credentialId"),
  CONSTRAINT "user_voice_preferences_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "user_voice_preferences_credentialId_userId_fkey" FOREIGN KEY ("credentialId", "userId")
    REFERENCES "user_voice_credentials"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "user_voice_preferences_default_key"
  ON "user_voice_preferences"("userId") WHERE "isDefault";

CREATE TABLE "user_action_approval_rules" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "effect" TEXT NOT NULL,
  "matchKind" TEXT NOT NULL,
  "matchValue" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_action_approval_rules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_action_approval_rules_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "user_action_approval_rules_userId_effect_matchKind_matchValue_key"
  ON "user_action_approval_rules"("userId", "effect", "matchKind", "matchValue");

CREATE TABLE "user_action_auto_review_preferences" (
  "userId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "skipApprovals" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "user_action_auto_review_preferences_pkey" PRIMARY KEY ("userId"),
  CONSTRAINT "user_action_auto_review_preferences_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Account rows belong to their user in every Space; override rows to one Space and user.
ALTER TABLE "space_setting_overrides" ENABLE ROW LEVEL SECURITY;
CREATE POLICY space_setting_overrides_tenant ON "space_setting_overrides"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
     AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY space_setting_overrides_system ON "space_setting_overrides"
  USING (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "user_model_role_choices" ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_model_role_choices_tenant ON "user_model_role_choices"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY user_model_role_choices_system ON "user_model_role_choices"
  USING (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "user_model_preferences" ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_model_preferences_tenant ON "user_model_preferences"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY user_model_preferences_system ON "user_model_preferences"
  USING (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "user_voice_preferences" ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_voice_preferences_tenant ON "user_voice_preferences"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY user_voice_preferences_system ON "user_voice_preferences"
  USING (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "user_action_approval_rules" ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_action_approval_rules_tenant ON "user_action_approval_rules"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY user_action_approval_rules_system ON "user_action_approval_rules"
  USING (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "user_action_auto_review_preferences" ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_action_auto_review_preferences_tenant ON "user_action_auto_review_preferences"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY user_action_auto_review_preferences_system ON "user_action_auto_review_preferences"
  USING (current_setting('app.rls_bypass', true) = 'on');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      "space_setting_overrides", "user_model_role_choices", "user_model_preferences",
      "user_voice_preferences", "user_action_approval_rules", "user_action_auto_review_preferences"
      TO rakazo_app;
  END IF;
END $$;

-- Each member's oldest Space becomes their account settings.
CREATE TEMP TABLE "account_source" AS
SELECT DISTINCT ON (m."userId") m."userId", m."spaceId"
FROM "space_members" m
ORDER BY m."userId", m."createdAt", m."id";

INSERT INTO "user_model_role_choices"
  ("userId", "role", "position", "provider", "modelId", "thinkingLevel", "credentialId")
SELECT r."userId", r."role", r."position", r."provider", r."modelId", r."thinkingLevel", r."credentialId"
FROM "space_model_role_choices" r
JOIN "account_source" s ON s."userId" = r."userId" AND s."spaceId" = r."spaceId";

-- A connection's own model was saved per Space; the most recently saved one wins.
INSERT INTO "user_model_preferences"
  ("userId", "credentialId", "modelId", "thinkingLevel", "createdAt", "updatedAt")
SELECT DISTINCT ON (p."userId", p."credentialId")
  p."userId", p."credentialId", p."modelId", p."thinkingLevel", p."createdAt", p."updatedAt"
FROM "space_model_preferences" p
ORDER BY p."userId", p."credentialId", p."updatedAt" DESC, p."id" DESC;

INSERT INTO "user_voice_preferences"
  ("userId", "credentialId", "voiceId", "speechModel", "isDefault", "createdAt", "updatedAt")
SELECT p."userId", p."credentialId", p."voiceId", p."speechModel", p."isDefault", p."createdAt", p."updatedAt"
FROM "space_voice_preferences" p
JOIN "account_source" s ON s."userId" = p."userId" AND s."spaceId" = p."spaceId";

INSERT INTO "user_action_approval_rules"
  ("id", "userId", "effect", "matchKind", "matchValue", "createdAt")
SELECT r."id", r."createdByUserId", r."effect", r."matchKind", r."matchValue", r."createdAt"
FROM "action_approval_rules" r
JOIN "account_source" s ON s."userId" = r."createdByUserId" AND s."spaceId" = r."spaceId";

INSERT INTO "user_action_auto_review_preferences"
  ("userId", "enabled", "skipApprovals", "createdAt", "updatedAt")
SELECT p."userId", p."enabled", p."skipApprovals", p."createdAt", p."updatedAt"
FROM "action_auto_review_preferences" p
JOIN "account_source" s ON s."userId" = p."userId" AND s."spaceId" = p."spaceId";

-- Every other Space whose settings differ from the account's keeps them as an override, so
-- nothing that runs today changes; Spaces that match follow the account from now on.
CREATE TEMP TABLE "space_setting_signatures" AS
SELECT
  m."spaceId",
  m."userId",
  (SELECT string_agg(concat_ws('|', r."role", r."position", r."provider", r."modelId",
            coalesce(r."thinkingLevel", ''), coalesce(r."credentialId", '')),
          ',' ORDER BY r."role", r."position")
   FROM "space_model_role_choices" r
   WHERE r."spaceId" = m."spaceId" AND r."userId" = m."userId") AS "models",
  (SELECT string_agg(concat_ws('|', p."credentialId", p."voiceId",
            coalesce(p."speechModel", ''), p."isDefault"),
          ',' ORDER BY p."credentialId")
   FROM "space_voice_preferences" p
   WHERE p."spaceId" = m."spaceId" AND p."userId" = m."userId") AS "voice",
  concat_ws(';',
    (SELECT string_agg(concat_ws('|', r."effect", r."matchKind", r."matchValue"),
              ',' ORDER BY r."effect", r."matchKind", r."matchValue")
     FROM "action_approval_rules" r
     WHERE r."spaceId" = m."spaceId" AND r."createdByUserId" = m."userId"),
    (SELECT concat_ws('|', p."enabled", p."skipApprovals")
     FROM "action_auto_review_preferences" p
     WHERE p."spaceId" = m."spaceId" AND p."userId" = m."userId")) AS "confirmations"
FROM "space_members" m;

INSERT INTO "space_setting_overrides" ("spaceId", "userId", "setting")
SELECT t."spaceId", t."userId", setting."name"
FROM "space_setting_signatures" t
JOIN "account_source" s ON s."userId" = t."userId" AND s."spaceId" <> t."spaceId"
JOIN "space_setting_signatures" a ON a."userId" = s."userId" AND a."spaceId" = s."spaceId"
CROSS JOIN LATERAL (VALUES
  ('models', t."models" IS DISTINCT FROM a."models"),
  ('voice', t."voice" IS DISTINCT FROM a."voice"),
  ('confirmations', t."confirmations" IS DISTINCT FROM a."confirmations")
) AS setting("name", "differs")
WHERE setting."differs";

DROP TABLE "space_setting_signatures";
DROP TABLE "account_source";
