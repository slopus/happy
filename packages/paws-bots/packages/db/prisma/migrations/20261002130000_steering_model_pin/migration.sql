-- An inbound delivery that waits stores the model its routines agreed on,
-- so the later turn keeps that pin.
ALTER TABLE "steering_messages" ADD COLUMN "modelProvider" TEXT;
ALTER TABLE "steering_messages" ADD COLUMN "modelId" TEXT;
ALTER TABLE "steering_messages" ADD COLUMN "thinkingLevel" TEXT;
