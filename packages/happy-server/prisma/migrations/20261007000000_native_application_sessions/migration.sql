ALTER TABLE "AIServiceBinding" ADD COLUMN "sessionId" TEXT, ADD COLUMN "historyRequestId" TEXT, ADD COLUMN "historyDeadline" TIMESTAMP(3), ADD COLUMN "historyCiphertext" TEXT;
CREATE UNIQUE INDEX "AIServiceBinding_sessionId_key" ON "AIServiceBinding"("sessionId");
ALTER TABLE "AppChatTurn" ADD COLUMN "sessionId" TEXT, ADD COLUMN "phase" TEXT;
-- Preserve immutable execution authority; only attach-once mapping and encrypted read jobs may change.
CREATE FUNCTION ai_service_binding_native_update() RETURNS trigger AS $$ BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'AI service records are immutable'; END IF;
 IF (to_jsonb(NEW) - ARRAY['sessionId','historyRequestId','historyDeadline','historyCiphertext']) IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['sessionId','historyRequestId','historyDeadline','historyCiphertext']) OR
    (OLD."sessionId" IS NOT NULL AND NEW."sessionId" IS DISTINCT FROM OLD."sessionId") THEN
  RAISE EXCEPTION 'AI service records are immutable';
 END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER ai_service_binding_immutable ON "AIServiceBinding";
CREATE TRIGGER ai_service_binding_immutable BEFORE UPDATE OR DELETE ON "AIServiceBinding"
 FOR EACH ROW EXECUTE FUNCTION ai_service_binding_native_update();

ALTER TABLE "AppChatWorker" ADD COLUMN "nativeSessions" BOOLEAN NOT NULL DEFAULT false;
