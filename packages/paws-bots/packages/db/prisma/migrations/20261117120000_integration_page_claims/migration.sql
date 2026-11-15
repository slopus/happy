-- App owners claim their integration page through the plugin submission queue. A claim names
-- the page and carries no repository, testing notes or logo. It waits unconfirmed until the
-- claimant opens the link emailed to an address at the app's domain.
ALTER TABLE "plugin_submissions" ADD COLUMN "claim" TEXT;
ALTER TABLE "plugin_submissions" ADD COLUMN "confirmToken" TEXT;
ALTER TABLE "plugin_submissions" ADD COLUMN "confirmExpiresAt" TIMESTAMP(3);
ALTER TABLE "plugin_submissions" ALTER COLUMN "logo" DROP NOT NULL;
ALTER TABLE "plugin_submissions" ALTER COLUMN "source" DROP NOT NULL;
ALTER TABLE "plugin_submissions" ALTER COLUMN "testing" DROP NOT NULL;

CREATE INDEX "plugin_submissions_claim_status_idx" ON "plugin_submissions"("claim", "status");
CREATE UNIQUE INDEX "plugin_submissions_confirmToken_key" ON "plugin_submissions"("confirmToken");
