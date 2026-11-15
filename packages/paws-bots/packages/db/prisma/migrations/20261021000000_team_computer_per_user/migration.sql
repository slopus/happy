-- A Team Computer is now shared only by one user's bots in a space, so one member's bots
-- cannot read another member's bot folders or see their processes.

-- The owner keeps the existing computer, its sandbox and its home under the old homeKey.
UPDATE "computers"
SET "scopeKey" = 'team:' || "spaceId" || ':' || "userId"
WHERE "scope" = 'team'
  AND "scopeKey" = 'team:' || "spaceId";

-- Every other member whose bots (live or archived) sit on that computer gets their own,
-- stopped until first use. The homeKey matches computerHomeKey() in packages/db: providers
-- keep only 40 characters of it, so it is a digest rather than the raw ids.
INSERT INTO "computers" (
  "id", "spaceId", "userId", "scope", "scopeKey", "homeKey", "kind", "state", "createdAt", "updatedAt"
)
SELECT DISTINCT ON (bot."spaceId", bot."userId")
  'team-computer-' || substr(encode(sha256(convert_to(bot."spaceId" || ':' || bot."userId", 'UTF8')), 'hex'), 1, 32),
  bot."spaceId",
  bot."userId",
  'team',
  'team:' || bot."spaceId" || ':' || bot."userId",
  'team-' || substr(encode(sha256(convert_to(bot."spaceId" || ':' || bot."userId", 'UTF8')), 'hex'), 1, 32),
  computer."kind",
  'stopped',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "bots" AS bot
JOIN "computers" AS computer ON computer."id" = bot."computerId"
WHERE computer."scope" = 'team'
  AND computer."userId" <> bot."userId"
ORDER BY bot."spaceId", bot."userId", computer."createdAt", computer."id"
ON CONFLICT DO NOTHING;

-- Their bots move to it. Files under bots/<botId> stay in the owner's home, as when a bot
-- switches computers.
UPDATE "bots" AS bot
SET "computerId" = own."id"
FROM "computers" AS shared, "computers" AS own
WHERE shared."id" = bot."computerId"
  AND shared."scope" = 'team'
  AND shared."userId" <> bot."userId"
  AND own."scopeKey" = 'team:' || bot."spaceId" || ':' || bot."userId";
