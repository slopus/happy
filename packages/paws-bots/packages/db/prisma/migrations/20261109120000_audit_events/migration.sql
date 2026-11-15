-- Additive: older releases never read or write these tables.
CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "spaceId" TEXT,
    "spaceName" TEXT,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "actorLabel" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "targetLabel" TEXT,
    "outcome" TEXT NOT NULL,
    "runId" TEXT,
    "threadId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_events_organizationId_createdAt_idx" ON "audit_events"("organizationId", "createdAt");
CREATE INDEX "audit_events_createdAt_idx" ON "audit_events"("createdAt");

CREATE TABLE "audit_event_forwarding" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "lastCreatedAt" TIMESTAMP(3),
    "lastEventId" TEXT,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "audit_event_forwarding_pkey" PRIMARY KEY ("id")
);

-- Append-only: rows are inserted and, past retention, deleted. Never rewritten.
CREATE FUNCTION "audit_events_append_only"() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_events_no_update"
    BEFORE UPDATE ON "audit_events"
    FOR EACH ROW EXECUTE FUNCTION "audit_events_append_only"();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    REVOKE UPDATE ON TABLE "audit_events" FROM rakazo_app;
  END IF;
END $$;

-- Written and read as system only: reads authorize the organization in the API.
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_events_system ON "audit_events"
  USING (current_setting('app.rls_bypass', true) = 'on');
