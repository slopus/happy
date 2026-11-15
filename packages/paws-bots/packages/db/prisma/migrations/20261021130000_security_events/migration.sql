-- CreateTable
CREATE TABLE "security_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "userId" TEXT,
    "spaceId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "security_events_createdAt_idx" ON "security_events"("createdAt");
CREATE INDEX "security_events_type_createdAt_idx" ON "security_events"("type", "createdAt");
CREATE INDEX "security_events_ip_createdAt_idx" ON "security_events"("ip", "createdAt");
CREATE INDEX "security_events_userId_createdAt_idx" ON "security_events"("userId", "createdAt");

-- Append-only: rows are inserted and, past retention, deleted. Never rewritten.
CREATE FUNCTION "security_events_append_only"() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'security_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "security_events_no_update"
    BEFORE UPDATE ON "security_events"
    FOR EACH ROW EXECUTE FUNCTION "security_events_append_only"();
