-- Cache breakdown on usage rows: inputTokens stays the billed total, these two
-- say how much of it was read from, or written to, the provider's prompt cache.
ALTER TABLE "usage_records" ADD COLUMN "cacheReadTokens" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "usage_records" ADD COLUMN "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0;
