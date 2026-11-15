-- A routine can run on its own model instead of the bot's. The run keeps the
-- choice it was created with, so editing the routine cannot swap the model of a
-- run that is already queued.
ALTER TABLE "routines" ADD COLUMN "modelProvider" TEXT;
ALTER TABLE "routines" ADD COLUMN "modelId" TEXT;
ALTER TABLE "routines" ADD COLUMN "thinkingLevel" TEXT;
ALTER TABLE "runs" ADD COLUMN "thinkingLevel" TEXT;
