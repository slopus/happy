-- Additive: the previous release ignores these columns and only writes pasted-code rows,
-- which still carry a ciphertext and read as pending with no lease.
ALTER TABLE "model_oauth_sessions" ALTER COLUMN "ciphertext" DROP NOT NULL;
ALTER TABLE "model_oauth_sessions" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "model_oauth_sessions" ADD COLUMN "error" TEXT;
ALTER TABLE "model_oauth_sessions" ADD COLUMN "result" JSONB;
ALTER TABLE "model_oauth_sessions" ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);
