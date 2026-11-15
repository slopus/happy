-- Per-bot denylist of built-in tool names. Empty keeps every capability-gated builtin available.
ALTER TABLE "bots" ADD COLUMN "disabledBuiltinTools" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
