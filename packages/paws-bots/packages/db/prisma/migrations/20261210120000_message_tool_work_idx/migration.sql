-- Sole statement so the index builds outside an implicit transaction, without
-- blocking chat writes. Matches history search's tool_work kind: replies that
-- used tools, so listing them or checking for any stays cheap across chats.
CREATE INDEX CONCURRENTLY "messages_tool_work_idx" ON "messages" ("threadId", "seq")
WHERE "role" = 'bot' AND jsonb_path_exists("blocks", '$[*] ? (@.kind == "steps")');
