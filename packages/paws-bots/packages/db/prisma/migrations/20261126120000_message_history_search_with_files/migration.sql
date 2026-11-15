-- Sole statement so the index builds outside an implicit transaction, without
-- blocking chat writes. Adds attachment names, with their separators made spaces,
-- to the conversational text history search matches.
CREATE INDEX CONCURRENTLY "messages_history_search_files_idx" ON "messages"
USING GIN (to_tsvector('simple', jsonb_path_query_array(blocks,
  '$[*] ? (@.kind == "text" || @.kind == "channel_message" || @.kind == "bot_message_received" || @.kind == "bot_message_sent" || @.kind == "handoff").text')::text || jsonb_path_query_array(blocks, '$[*] ? (@.kind == "subagent").task')::text || jsonb_path_query_array(blocks, '$[*] ? (@.kind == "subagent").result')::text || translate(jsonb_path_query_array(blocks, '$[*] ? (@.kind == "file" || @.kind == "image").name')::text, '._-', '   ')));
