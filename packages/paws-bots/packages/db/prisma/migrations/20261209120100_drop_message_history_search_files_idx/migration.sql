-- deferred
-- Sole statement so DROP INDEX CONCURRENTLY runs outside an implicit transaction.
-- messages_history_search_steps_idx replaces it once the previous release stops searching.
DROP INDEX CONCURRENTLY IF EXISTS "messages_history_search_files_idx";
