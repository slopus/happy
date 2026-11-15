-- Marks this release's sends in flight apart from the previous release's, which never set it.
ALTER TABLE "messaging_outbound" ADD COLUMN "claimedAt" TIMESTAMP(3);
