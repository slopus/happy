-- Sole statement so DROP INDEX CONCURRENTLY runs outside an implicit transaction.
DROP INDEX CONCURRENTLY IF EXISTS "phone_outbound_status_idx";
