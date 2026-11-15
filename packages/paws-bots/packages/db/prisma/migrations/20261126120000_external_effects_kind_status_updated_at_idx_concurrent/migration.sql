-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit
-- transaction. The worker finds stalled videos across Spaces by kind and last update.
CREATE INDEX CONCURRENTLY "external_effects_kind_status_updatedAt_idx" ON "external_effects" ("kind", "status", "updatedAt");
