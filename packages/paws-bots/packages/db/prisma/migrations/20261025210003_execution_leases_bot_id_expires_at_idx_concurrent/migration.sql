-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit
-- transaction. The run wakeup scan reads live leases by botId on every pass.
CREATE INDEX CONCURRENTLY "computer_execution_leases_botId_expiresAt_idx" ON "computer_execution_leases"("botId", "expiresAt");
