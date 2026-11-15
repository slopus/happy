-- Space environment variables (agent_secrets) move into the vault as command variables of the
-- member who saved them. Additive: agent_secrets and its secrets rows stay for the previous
-- release and are dropped in a later deploy.
--
-- Where each one goes never widens who can read it: the Space's own vault when the Space already
-- has one or the member has other Spaces (which then marks the Space as customizing
-- "credentials"), else the account vault of a member with this one Space. The vault name is the
-- variable lower-cased, which exports as the same variable. A name or exported variable already
-- taken in that vault gets the first free "-N" suffix within 64 characters, as the vault copy did.
DO $$
DECLARE
  item RECORD;
  vault_space TEXT;
  candidate TEXT;
  suffix INTEGER;
BEGIN
  FOR item IN
    SELECT a."spaceId", a."createdByUserId" AS "userId", lower(a."name") AS "name",
      a."createdAt", a."updatedAt", s."id" AS "secretId", s."ciphertext",
      EXISTS (
        SELECT 1 FROM "space_setting_overrides" o
        WHERE o."spaceId" = a."spaceId" AND o."userId" = a."createdByUserId"
          AND o."setting" = 'credentials'
      ) AS "ownVault",
      (SELECT count(*) FROM "space_members" m WHERE m."userId" = a."createdByUserId") AS spaces,
      EXISTS (
        SELECT 1 FROM "space_members" m
        WHERE m."spaceId" = a."spaceId" AND m."userId" = a."createdByUserId"
      ) AS "isMember"
    FROM "agent_secrets" a
    JOIN "secrets" s ON s."id" = a."secretId"
    ORDER BY a."createdByUserId", a."updatedAt" DESC, a."id"
  LOOP
    -- A member who left the Space no longer has a vault there to receive it.
    CONTINUE WHEN NOT item."isMember";
    vault_space := CASE WHEN item."ownVault" OR item.spaces > 1 THEN item."spaceId" ELSE NULL END;
    candidate := item."name";
    suffix := 1;
    WHILE EXISTS (
      SELECT 1 FROM "vault_credentials" v
      WHERE v."userId" = item."userId"
        AND v."spaceId" IS NOT DISTINCT FROM vault_space
        AND (v."name" = candidate
          OR (v."auth"->>'type' = 'command'
            AND upper(replace(v."name", '-', '_')) = upper(replace(candidate, '-', '_'))))
    ) LOOP
      suffix := suffix + 1;
      candidate := left(item."name", 64 - length('-' || suffix)) || '-' || suffix;
    END LOOP;
    INSERT INTO "vault_credentials"
      ("id", "userId", "spaceId", "name", "origin", "auth", "ciphertext", "createdAt", "updatedAt")
    VALUES (item."secretId", item."userId", vault_space, candidate, '', '{"type":"command"}',
      item."ciphertext", item."createdAt", item."updatedAt")
    ON CONFLICT ("id") DO NOTHING;
    IF vault_space IS NOT NULL THEN
      INSERT INTO "space_setting_overrides" ("spaceId", "userId", "setting")
      VALUES (item."spaceId", item."userId", 'credentials')
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
END $$;
