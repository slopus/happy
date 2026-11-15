-- A routine run that follows its bot records the model an attempt used in the
-- same columns as an explicit pin. This flag keeps that record from becoming a pin.
ALTER TABLE "runs" ADD COLUMN "modelPinned" BOOLEAN NOT NULL DEFAULT false;
