-- Environments that already applied the case-sensitive unique index from an earlier revision.
DROP INDEX IF EXISTS "agent_skills_workspaceId_userId_name_key";
DROP INDEX IF EXISTS "agent_skills_workspaceId_userId_name_ci_key";

-- Preserve case-variant duplicates by renaming older rows (never delete content).
-- Candidate names include the row id and retry until lower(name) is unique per owner.
DO $$
DECLARE
  dup RECORD;
  candidate TEXT;
  attempt INT;
BEGIN
  FOR dup IN
    SELECT older.id, older.name, older."workspaceId", older."userId"
    FROM "agent_skills" AS older
    WHERE EXISTS (
      SELECT 1
      FROM "agent_skills" AS newer
      WHERE older."workspaceId" = newer."workspaceId"
        AND older."userId" = newer."userId"
        AND lower(older."name") = lower(newer."name")
        AND older.id <> newer.id
        AND (
          older."updatedAt" < newer."updatedAt"
          OR (older."updatedAt" = newer."updatedAt" AND older.id < newer.id)
        )
    )
    ORDER BY older."updatedAt" ASC, older.id ASC
  LOOP
    attempt := 0;
    LOOP
      IF attempt = 0 THEN
        candidate := left(dup.name, greatest(1, 80 - length(dup.id) - 1)) || '-' || dup.id;
      ELSE
        candidate := left(
          dup.name,
          greatest(1, 80 - length(dup.id) - length(attempt::text) - 2)
        ) || '-' || dup.id || '-' || attempt::text;
      END IF;
      candidate := left(candidate, 80);
      EXIT WHEN NOT EXISTS (
        SELECT 1
        FROM "agent_skills"
        WHERE "workspaceId" = dup."workspaceId"
          AND "userId" = dup."userId"
          AND lower("name") = lower(candidate)
          AND id <> dup.id
      );
      attempt := attempt + 1;
      IF attempt > 1000 THEN
        RAISE EXCEPTION
          'Unable to rename duplicate agent skill % (%) to a unique name',
          dup.id,
          dup.name;
      END IF;
    END LOOP;

    UPDATE "agent_skills"
    SET name = candidate, "updatedAt" = CURRENT_TIMESTAMP
    WHERE id = dup.id;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "agent_skills_workspaceId_userId_name_lower_key"
  ON "agent_skills"("workspaceId", "userId", (lower("name")));
