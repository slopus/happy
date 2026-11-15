CREATE TABLE "bot_sections" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "bot_sections_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "bots" ADD COLUMN "sectionId" TEXT;

CREATE UNIQUE INDEX "bot_sections_workspaceId_userId_name_key"
ON "bot_sections"("workspaceId", "userId", "name");

CREATE INDEX "bot_sections_workspaceId_userId_position_createdAt_idx"
ON "bot_sections"("workspaceId", "userId", "position", "createdAt");

CREATE INDEX "bots_sectionId_idx" ON "bots"("sectionId");

ALTER TABLE "bot_sections"
ADD CONSTRAINT "bot_sections_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "organization"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "bot_sections"
ADD CONSTRAINT "bot_sections_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "user"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "bots"
ADD CONSTRAINT "bots_sectionId_fkey"
FOREIGN KEY ("sectionId") REFERENCES "bot_sections"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
