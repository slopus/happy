-- A member's credentials move from one bot to a vault: the account's, which every Space uses,
-- or a Space's own once it customizes "credentials". Additive: bot_secrets stays for the
-- previous release and is dropped in a later deploy.

CREATE TABLE "vault_credentials" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "spaceId" TEXT,
  "name" TEXT NOT NULL,
  "origin" TEXT NOT NULL,
  "auth" JSONB NOT NULL,
  "ciphertext" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "vault_credentials_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "vault_credentials_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "vault_credentials_spaceId_fkey" FOREIGN KEY ("spaceId")
    REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "vault_credentials_spaceId_idx" ON "vault_credentials"("spaceId");
CREATE UNIQUE INDEX "vault_credentials_userId_spaceId_name_key"
  ON "vault_credentials"("userId", "spaceId", "name")
  NULLS NOT DISTINCT;

ALTER TABLE "vault_credentials" ENABLE ROW LEVEL SECURITY;
CREATE POLICY vault_credentials_tenant ON "vault_credentials"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), '')
    AND ("spaceId" IS NULL OR "spaceId" = NULLIF(current_setting('app.space_id', true), '')));
CREATE POLICY vault_credentials_system ON "vault_credentials"
  USING (current_setting('app.rls_bypass', true) = 'on');

-- Saved credentials never become readable somewhere they were not: a member with one Space
-- gets them in the account vault (no other Space exists to see them); a member with several
-- keeps each Space's in that Space's own vault. Rows keep their ids, which their stored values
-- are bound to. Within a vault the newest row keeps its name; an older row whose name, or for a
-- command variable whose exported variable, is taken gets the first free "-N" suffix that keeps
-- the name within 64 characters.
DO $$
DECLARE
  row RECORD;
  vault_space TEXT;
  candidate TEXT;
  suffix INTEGER;
  is_command BOOLEAN;
BEGIN
  FOR row IN
    SELECT b.*,
      (SELECT count(*) FROM "space_members" m WHERE m."userId" = b."userId") AS spaces
    FROM "bot_secrets" b
    ORDER BY b."userId", b."updatedAt" DESC, b."id"
  LOOP
    vault_space := CASE WHEN row.spaces = 1 THEN NULL ELSE row."spaceId" END;
    is_command := row."auth"->>'type' = 'command';
    candidate := row."name";
    suffix := 1;
    WHILE EXISTS (
      SELECT 1 FROM "vault_credentials" v
      WHERE v."userId" = row."userId"
        AND v."spaceId" IS NOT DISTINCT FROM vault_space
        AND (v."name" = candidate
          OR (is_command AND v."auth"->>'type' = 'command'
            AND upper(replace(v."name", '-', '_')) = upper(replace(candidate, '-', '_'))))
    ) LOOP
      suffix := suffix + 1;
      candidate := left(row."name", 64 - length('-' || suffix)) || '-' || suffix;
    END LOOP;
    INSERT INTO "vault_credentials"
      ("id", "userId", "spaceId", "name", "origin", "auth", "ciphertext", "createdAt", "updatedAt")
    VALUES (row."id", row."userId", vault_space, candidate, row."origin", row."auth",
      row."ciphertext", row."createdAt", row."updatedAt")
    ON CONFLICT ("id") DO NOTHING;
  END LOOP;
END $$;

INSERT INTO "space_setting_overrides" ("spaceId", "userId", "setting")
SELECT DISTINCT v."spaceId", v."userId", 'credentials'
FROM "vault_credentials" v
JOIN "space_members" m ON m."spaceId" = v."spaceId" AND m."userId" = v."userId"
WHERE v."spaceId" IS NOT NULL
ON CONFLICT DO NOTHING;
