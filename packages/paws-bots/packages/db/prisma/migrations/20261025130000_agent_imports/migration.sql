CREATE TABLE "agent_imports" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "created" JSONB NOT NULL,
    "importKey" TEXT,
    "requestDigest" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_imports_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agent_imports_botId_createdAt_idx" ON "agent_imports"("botId", "createdAt");
CREATE UNIQUE INDEX "agent_imports_spaceId_userId_importKey_key" ON "agent_imports"("spaceId", "userId", "importKey");

ALTER TABLE "agent_imports" ADD CONSTRAINT "agent_imports_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_imports" ADD CONSTRAINT "agent_imports_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Same policies as agent_skills (20261021140000_row_level_security).
ALTER TABLE "agent_imports" ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_imports_tenant ON "agent_imports"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY agent_imports_system ON "agent_imports"
  USING (current_setting('app.rls_bypass', true) = 'on');
