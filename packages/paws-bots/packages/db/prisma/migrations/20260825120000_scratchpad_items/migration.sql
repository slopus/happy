CREATE TABLE "scratchpad_items" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "notes" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "scratchpad_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "scratchpad_items_workspaceId_botId_status_idx" ON "scratchpad_items"("workspaceId", "botId", "status");
CREATE INDEX "scratchpad_items_workspaceId_botId_updatedAt_idx" ON "scratchpad_items"("workspaceId", "botId", "updatedAt");

ALTER TABLE "scratchpad_items" ADD CONSTRAINT "scratchpad_items_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "scratchpad_items" ADD CONSTRAINT "scratchpad_items_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
