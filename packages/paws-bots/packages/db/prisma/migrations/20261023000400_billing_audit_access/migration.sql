-- Journal access is internal/system-only; application UI reads tenant-scoped projections.
ALTER TABLE billing_audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY billing_audit_events_system ON billing_audit_events
 USING (current_setting('app.rls_bypass',true)='on');
ALTER TABLE usage_records ADD COLUMN "pricingSnapshot" JSONB;
CREATE FUNCTION billing_credit_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."organizationId" IS DISTINCT FROM OLD."organizationId" OR NEW."callId" IS DISTINCT FROM OLD."callId"
 OR NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."spaceId" IS DISTINCT FROM OLD."spaceId"
 OR NEW.provider IS DISTINCT FROM OLD.provider OR NEW.model IS DISTINCT FROM OLD.model OR NEW.source IS DISTINCT FROM OLD.source
 OR (OLD."providerRequestId" IS NOT NULL AND NEW."providerRequestId" IS DISTINCT FROM OLD."providerRequestId")
 THEN RAISE EXCEPTION 'Credit attribution is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER credit_identity_immutable BEFORE UPDATE ON model_credit_entries FOR EACH ROW EXECUTE FUNCTION billing_credit_identity_immutable();
