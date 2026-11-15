ALTER TABLE "bots" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;

WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "workspaceId", "userId"
      ORDER BY "updatedAt" DESC, "createdAt" ASC, "id" ASC
    ) - 1 AS "position"
  FROM "bots"
)
UPDATE "bots"
SET "position" = ranked."position"
FROM ranked
WHERE "bots"."id" = ranked."id";
