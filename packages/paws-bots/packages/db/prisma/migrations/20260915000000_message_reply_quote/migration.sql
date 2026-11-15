-- Selected-text excerpts on replies: the reply still points at the whole message,
-- the quote carries just the span the user highlighted.
ALTER TABLE "messages" ADD COLUMN "replyQuote" text;
