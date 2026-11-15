ALTER TABLE "computers" ADD COLUMN "runningSince" TIMESTAMP(3);

-- Computers already up start their active-lifetime clock at deploy.
UPDATE "computers" SET "runningSince" = CURRENT_TIMESTAMP WHERE "state" = 'running';
