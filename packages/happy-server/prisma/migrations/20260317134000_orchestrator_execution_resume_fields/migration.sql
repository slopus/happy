-- Add execution resume auditing fields for orchestrator child sessions
ALTER TABLE "OrchestratorExecution"
ADD COLUMN "childSessionId" TEXT,
ADD COLUMN "executionType" TEXT NOT NULL DEFAULT 'initial',
ADD COLUMN "resumeMessage" TEXT;
