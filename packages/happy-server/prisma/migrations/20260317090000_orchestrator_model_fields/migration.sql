-- Add task-level model selection and execution-level audited model for orchestrator
ALTER TABLE "OrchestratorTask"
ADD COLUMN "model" TEXT;

ALTER TABLE "OrchestratorExecution"
ADD COLUMN "model" TEXT;
