ALTER TABLE "cloud_agents" ADD COLUMN "followupDispatchedAt" TIMESTAMP(3);
UPDATE "cloud_agents" SET "followupDispatchedAt" = CURRENT_TIMESTAMP WHERE "followupDispatching";
ALTER TABLE "cloud_agents" DROP COLUMN "followupDispatching";
