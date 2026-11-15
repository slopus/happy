-- CreateTable
CREATE TABLE "taught_skills" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "goal" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "playbook" JSONB NOT NULL DEFAULT '{}',
    "recording" JSONB NOT NULL DEFAULT '{"events":[],"snapshots":[]}',
    "startedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "taught_skills_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "taught_skills_workspaceId_botId_idx" ON "taught_skills"("workspaceId", "botId");

-- CreateIndex
CREATE INDEX "taught_skills_workspaceId_botId_status_idx" ON "taught_skills"("workspaceId", "botId", "status");

-- AddForeignKey
ALTER TABLE "taught_skills" ADD CONSTRAINT "taught_skills_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "taught_skills" ADD CONSTRAINT "taught_skills_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
