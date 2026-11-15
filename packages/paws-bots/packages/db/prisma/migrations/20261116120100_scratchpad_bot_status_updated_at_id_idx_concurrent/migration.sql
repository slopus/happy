-- Sole statement so the bot-scoped stale-work index builds without blocking writes.
CREATE INDEX CONCURRENTLY "scratchpad_items_botId_status_updatedAt_id_idx" ON "scratchpad_items"("botId", "status", "updatedAt", "id");
