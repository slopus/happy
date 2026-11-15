CREATE TABLE "action_approval_rules" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "effect" TEXT NOT NULL,
    "matchKind" TEXT NOT NULL,
    "matchValue" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "action_approval_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "action_approval_rules_workspaceId_createdByUserId_idx" ON "action_approval_rules"("workspaceId", "createdByUserId");

CREATE UNIQUE INDEX "action_approval_rules_workspaceId_createdByUserId_effect_matchKind_matchValue_key" ON "action_approval_rules"("workspaceId", "createdByUserId", "effect", "matchKind", "matchValue");

ALTER TABLE "action_approval_rules" ADD CONSTRAINT "action_approval_rules_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "action_approval_rules" ADD CONSTRAINT "action_approval_rules_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
