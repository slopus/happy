-- Auto Review preference (per user in a workspace) and audit columns on external effects.

CREATE TABLE "action_auto_review_preferences" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "action_auto_review_preferences_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "action_auto_review_preferences_workspaceId_userId_key" ON "action_auto_review_preferences"("workspaceId", "userId");

ALTER TABLE "action_auto_review_preferences" ADD CONSTRAINT "action_auto_review_preferences_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "action_auto_review_preferences" ADD CONSTRAINT "action_auto_review_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "external_effects" ADD COLUMN "reviewDecision" TEXT;
ALTER TABLE "external_effects" ADD COLUMN "reviewReason" TEXT;
ALTER TABLE "external_effects" ADD COLUMN "reviewModel" TEXT;
