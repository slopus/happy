-- Additive: the previous release never reads these columns, and keeps reading bots."avatarSet",
-- which stays each bot's effective set.
ALTER TABLE "user" ADD COLUMN "botAvatarSet" TEXT NOT NULL DEFAULT 'organic';
ALTER TABLE "bots" ADD COLUMN "avatarSetPinned" BOOLEAN NOT NULL DEFAULT false;

-- Each account starts on the set most of its bots already wear (Original on a tie), so no bot
-- changes look. Bots that differ from it are pinned, so changing the default later leaves them.
UPDATE "user" AS u
SET "botAvatarSet" = 'rakazo'
FROM (
  SELECT "userId",
         COUNT(*) FILTER (WHERE "avatarSet" = 'rakazo') AS rakazo,
         COUNT(*) FILTER (WHERE "avatarSet" <> 'rakazo') AS other
  FROM "bots"
  WHERE "archivedAt" IS NULL
  GROUP BY "userId"
) AS counts
WHERE counts."userId" = u."id" AND counts.rakazo > counts.other;

UPDATE "bots" AS b
SET "avatarSetPinned" = true
FROM "user" AS u
WHERE u."id" = b."userId" AND b."avatarSet" <> u."botAvatarSet";
