CREATE TABLE "AIServiceHistoryRequest" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "bindingId" TEXT NOT NULL REFERENCES "AIServiceBinding"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "sessionId" TEXT NOT NULL,
 "state" TEXT NOT NULL DEFAULT 'queued',
 "ciphertext" TEXT,
 "error" TEXT,
 "deadline" TIMESTAMP(3) NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "AIServiceHistoryRequest_bindingId_state_deadline_idx" ON "AIServiceHistoryRequest"("bindingId", "state", "deadline");
-- Release obsolete single-slot cached bytes while preserving the immutable execution binding.
UPDATE "AppDelegation" AS storage SET "storedBytes" = GREATEST(0, storage."storedBytes" - old.bytes)
 FROM (SELECT "authorizationId", SUM(octet_length("historyCiphertext"))::integer AS bytes
       FROM "AIServiceBinding" WHERE "historyCiphertext" IS NOT NULL GROUP BY "authorizationId") old
 WHERE storage."id" = old."authorizationId";
UPDATE "AIServiceBinding" SET "historyRequestId" = NULL, "historyDeadline" = NULL, "historyCiphertext" = NULL;
