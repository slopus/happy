-- Sole statement so the index builds outside an implicit transaction, without
-- blocking chat writes. Adds tool step labels and notes, so a bot can find what
-- it did with tools in an earlier reply.
CREATE INDEX CONCURRENTLY "messages_history_search_steps_idx" ON "messages"
USING GIN (to_tsvector('simple', jsonb_path_query_array(blocks,
  '$[*] ? (@.kind == "text" || @.kind == "channel_message" || @.kind == "bot_message_received" || @.kind == "bot_message_sent" || @.kind == "handoff").text')::text || jsonb_path_query_array(blocks, '$[*] ? (@.kind == "subagent").task')::text || jsonb_path_query_array(blocks, '$[*] ? (@.kind == "subagent").result')::text || translate(jsonb_path_query_array(blocks, '$[*] ? (@.kind == "file" || @.kind == "image").name')::text, '._-', '   ') || jsonb_path_query_array(blocks, '$[*] ? (@.kind == "steps").steps[*].label')::text || jsonb_path_query_array(blocks, '$[*] ? (@.kind == "steps").steps[*].note')::text));
