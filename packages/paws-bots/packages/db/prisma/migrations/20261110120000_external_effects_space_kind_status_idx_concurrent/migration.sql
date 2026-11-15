-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit
-- transaction. Approving the user's computer once covers the whole space.
CREATE INDEX CONCURRENTLY "external_effects_spaceId_kind_status_idx" ON "external_effects" ("spaceId", "kind", "status");
