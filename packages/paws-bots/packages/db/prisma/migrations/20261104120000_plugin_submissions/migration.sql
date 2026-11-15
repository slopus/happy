-- Additive: the previous release never reads this table.
CREATE TABLE "plugin_submissions" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "website" TEXT,
    "logo" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "testing" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "pinnedSource" TEXT,
    "hasConnector" BOOLEAN NOT NULL DEFAULT false,
    "skillCount" INTEGER NOT NULL DEFAULT 0,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plugin_submissions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "plugin_submissions_status_createdAt_idx" ON "plugin_submissions"("status", "createdAt");

CREATE INDEX "plugin_submissions_source_idx" ON "plugin_submissions"("source");
