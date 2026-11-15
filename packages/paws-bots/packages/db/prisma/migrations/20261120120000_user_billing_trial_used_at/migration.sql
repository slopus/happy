-- Once set, no organization this person owns is offered a trial, even after the one that used it is deleted.
ALTER TABLE "user" ADD COLUMN "billingTrialUsedAt" TIMESTAMP(3);
