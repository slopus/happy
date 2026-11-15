-- Additive: the previous API continues using the existing wallet and entries.
ALTER TABLE model_credit_entries ADD COLUMN allocations JSONB;
CREATE TABLE model_credit_lots (
 id TEXT PRIMARY KEY,
 "organizationId" TEXT NOT NULL REFERENCES model_credit_accounts("organizationId") ON DELETE CASCADE,
 "amountMicros" BIGINT NOT NULL,
 "availableMicros" BIGINT NOT NULL CHECK ("availableMicros" >= 0),
 "usedMicros" BIGINT NOT NULL DEFAULT 0 CHECK ("usedMicros" >= 0),
 "expiredMicros" BIGINT NOT NULL DEFAULT 0 CHECK ("expiredMicros" >= 0),
 "expiresAt" TIMESTAMP(3),
 "auditRevision" INTEGER NOT NULL DEFAULT 0,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "model_credit_lots_organizationId_expiresAt_idx" ON model_credit_lots("organizationId","expiresAt");
CREATE INDEX "model_credit_lots_expiresAt_idx" ON model_credit_lots("expiresAt");
GRANT SELECT, INSERT, UPDATE, DELETE ON model_credit_lots TO rakazo_app;
CREATE TRIGGER lot_audit_revision BEFORE UPDATE ON model_credit_lots FOR EACH ROW EXECUTE FUNCTION billing_audit_revision();
CREATE FUNCTION billing_audit_lot() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
 INSERT INTO public.billing_audit_events(source,kind,"organizationId",details)
 VALUES ('lot:'||NEW.id||':'||NEW."auditRevision", CASE WHEN TG_OP='UPDATE' AND NEW."expiredMicros">OLD."expiredMicros" THEN 'credits_expired' ELSE 'credit_allocation' END, NEW."organizationId",to_jsonb(NEW));
 RETURN NEW;
END $$;
CREATE TRIGGER lot_audit_write AFTER INSERT OR UPDATE ON model_credit_lots FOR EACH ROW EXECUTE FUNCTION billing_audit_lot();
