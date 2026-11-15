ALTER TABLE "computers" ADD COLUMN "controlRunId" TEXT;

UPDATE "computers" AS computer
SET "controlRunId" = lease."runId"
FROM "computer_execution_leases" AS lease
JOIN "runs" AS waiting_run ON waiting_run."id" = lease."runId"
WHERE computer."controlLeaseId" IS NOT NULL
  AND computer."controlBotId" = lease."botId"
  AND computer."id" = lease."computerId"
  AND waiting_run."status" = 'waiting_takeover';
