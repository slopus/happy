-- Space-scoped default thinking level for a credential's chosen model; bots keep
-- their own override column on bots.thinkingLevel.
ALTER TABLE "space_model_preferences" ADD COLUMN "thinkingLevel" TEXT;
