-- CreateTable
CREATE TABLE "agent_skills" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'user',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_skills_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_skills_workspaceId_userId_idx" ON "agent_skills"("workspaceId", "userId");

-- Case-insensitive unique name per workspace+user (matches insensitive lookups / clash checks).
CREATE UNIQUE INDEX "agent_skills_workspaceId_userId_name_lower_key"
  ON "agent_skills"("workspaceId", "userId", (lower("name")));

-- AddForeignKey
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
