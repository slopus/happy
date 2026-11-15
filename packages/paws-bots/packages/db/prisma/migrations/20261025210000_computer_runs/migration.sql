-- Additive: the previous release never reads or writes this table.
CREATE TABLE "computer_runs" (
    "id" TEXT NOT NULL,
    "computerId" TEXT NOT NULL,
    "spaceId" TEXT,
    "userId" TEXT,
    "kind" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,

    CONSTRAINT "computer_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "computer_runs_computerId_startedAt_key" ON "computer_runs"("computerId", "startedAt");
CREATE INDEX "computer_runs_spaceId_userId_startedAt_idx" ON "computer_runs"("spaceId", "userId", "startedAt");
CREATE INDEX "computer_runs_open_idx" ON "computer_runs"("computerId") WHERE "endedAt" IS NULL;

-- Deleting the user or space keeps the run time and drops who it belonged to.
ALTER TABLE "computer_runs" ADD CONSTRAINT "computer_runs_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "computer_runs" ADD CONSTRAINT "computer_runs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Same policies as agent_imports. Anonymised rows (no space) are visible only as system.
ALTER TABLE "computer_runs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY computer_runs_tenant ON "computer_runs"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY computer_runs_system ON "computer_runs"
  USING (current_setting('app.rls_bypass', true) = 'on');
