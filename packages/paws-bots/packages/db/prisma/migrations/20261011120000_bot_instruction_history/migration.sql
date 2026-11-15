ALTER TABLE "bots" ADD COLUMN "selfUpdateInstructions" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "instructionHistory" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "pendingInstructionsRunId" TEXT;
