-- Lifecycle rows are not the owners of financial history.
ALTER TABLE usage_records DROP CONSTRAINT IF EXISTS "usage_records_spaceId_fkey";
ALTER TABLE usage_records DROP CONSTRAINT IF EXISTS "usage_records_runId_fkey";
ALTER TABLE usage_records ADD COLUMN "providerRequestId" TEXT, ADD COLUMN currency TEXT NOT NULL DEFAULT 'usd', ADD COLUMN "auditRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE model_credit_entries
 ADD COLUMN "callId" TEXT, ADD COLUMN "userId" TEXT, ADD COLUMN "spaceId" TEXT,
 ADD COLUMN "runId" TEXT, ADD COLUMN provider TEXT, ADD COLUMN model TEXT,
 ADD COLUMN "providerRequestId" TEXT, ADD COLUMN usage JSONB,
 ADD COLUMN "reconciliationState" TEXT, ADD COLUMN "reconciliationAttempts" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "nextReconcileAt" TIMESTAMP(3), ADD COLUMN "auditRevision" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "model_credit_entries_callId_key" ON model_credit_entries("callId");
CREATE INDEX "model_credit_entries_reconciliationState_nextReconcileAt_idx" ON model_credit_entries("reconciliationState", "nextReconcileAt");
CREATE TABLE billing_audit_events (
 id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
 source TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
 "organizationId" TEXT, "callId" TEXT, "userId" TEXT, "spaceId" TEXT,
 provider TEXT, model TEXT, "providerRequestId" TEXT,
 "amountMicros" BIGINT NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'usd',
 details JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "billing_audit_events_organizationId_createdAt_idx" ON billing_audit_events("organizationId", "createdAt");
CREATE INDEX "billing_audit_events_callId_createdAt_idx" ON billing_audit_events("callId", "createdAt");
-- Existing balances are an explicit baseline, not a fabricated reconstruction of older events.
INSERT INTO billing_audit_events(source,kind,"organizationId","amountMicros",details)
 SELECT 'baseline:credit:'||id,'baseline',"organizationId","amountMicros",to_jsonb(e) FROM model_credit_entries e;
INSERT INTO billing_audit_events(source,kind,"callId","userId","spaceId",provider,model,details)
 SELECT 'baseline:usage:'||id,'usage_baseline',"callId","userId","spaceId",provider,model,to_jsonb(u) FROM usage_records u;
CREATE FUNCTION billing_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Billing audit events are append-only'; END $$;
CREATE TRIGGER billing_audit_no_mutation BEFORE UPDATE OR DELETE OR TRUNCATE ON billing_audit_events FOR EACH STATEMENT EXECUTE FUNCTION billing_audit_immutable();
CREATE FUNCTION billing_audit_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW."auditRevision" := OLD."auditRevision" + 1; RETURN NEW; END $$;
CREATE TRIGGER credit_audit_revision BEFORE UPDATE ON model_credit_entries FOR EACH ROW EXECUTE FUNCTION billing_audit_revision();
CREATE TRIGGER usage_audit_revision BEFORE UPDATE ON usage_records FOR EACH ROW EXECUTE FUNCTION billing_audit_revision();
CREATE FUNCTION billing_audit_credit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE delta BIGINT; event_kind TEXT;
BEGIN
 delta := NEW."amountMicros" - CASE WHEN TG_OP='INSERT' THEN 0 ELSE OLD."amountMicros" END;
 event_kind := CASE
  WHEN TG_OP='INSERT' AND NEW.pending THEN 'reservation'
  WHEN TG_OP='INSERT' THEN 'purchase'
  WHEN OLD.pending AND NOT NEW.pending THEN 'settlement'
  WHEN NEW.source LIKE 'purchase:%' AND delta < 0 THEN 'refund'
  WHEN delta <> 0 THEN 'correction'
  WHEN NEW.usage IS DISTINCT FROM OLD.usage THEN 'receipt'
  WHEN NEW."providerRequestId" IS DISTINCT FROM OLD."providerRequestId" THEN 'provider_request'
  ELSE 'reconciliation' END;
 INSERT INTO public.billing_audit_events(source,kind,"organizationId","callId","userId","spaceId",provider,model,"providerRequestId","amountMicros",details)
 VALUES ('credit:'||NEW.id||':'||NEW."auditRevision",event_kind,NEW."organizationId",NEW."callId",NEW."userId",NEW."spaceId",NEW.provider,NEW.model,NEW."providerRequestId",delta,
 jsonb_build_object('entry',to_jsonb(NEW),'previous',CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END));
 RETURN NEW;
END $$;
CREATE TRIGGER credit_audit_write AFTER INSERT OR UPDATE ON model_credit_entries FOR EACH ROW EXECUTE FUNCTION billing_audit_credit();
CREATE FUNCTION billing_audit_usage() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org TEXT;
BEGIN
 SELECT "organizationId" INTO org FROM public.model_credit_entries WHERE "callId"=NEW."callId";
 IF org IS NULL THEN SELECT "organizationId" INTO org FROM public.spaces WHERE id=NEW."spaceId"; END IF;
 INSERT INTO public.billing_audit_events(source,kind,"organizationId","callId","userId","spaceId",provider,model,"providerRequestId",details)
 VALUES ('usage:'||NEW.id||':'||NEW."auditRevision",CASE WHEN TG_OP='INSERT' THEN 'usage' ELSE 'usage_correction' END,org,NEW."callId",NEW."userId",NEW."spaceId",NEW.provider,NEW.model,NEW."providerRequestId",to_jsonb(NEW));
 RETURN NEW;
END $$;
CREATE TRIGGER usage_audit_write AFTER INSERT OR UPDATE ON usage_records FOR EACH ROW EXECUTE FUNCTION billing_audit_usage();
CREATE FUNCTION billing_audit_account_closed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
 INSERT INTO public.billing_audit_events(source,kind,"organizationId",details)
 VALUES ('closed:'||gen_random_uuid()::text,'account_closed',OLD."organizationId",to_jsonb(OLD));
 RETURN OLD;
END $$;
CREATE TRIGGER credit_audit_account_closed BEFORE DELETE ON model_credit_accounts FOR EACH ROW EXECUTE FUNCTION billing_audit_account_closed();
GRANT SELECT,INSERT ON billing_audit_events TO rakazo_app;
REVOKE UPDATE,DELETE,TRUNCATE ON billing_audit_events FROM rakazo_app;
REVOKE DELETE,TRUNCATE ON usage_records FROM rakazo_app;
