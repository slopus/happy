-- Additive: the previous release ignores these columns, and its card rows read back as "card".
ALTER TABLE "purchases" ADD COLUMN "credentialType" TEXT NOT NULL DEFAULT 'card';
ALTER TABLE "purchases" ADD COLUMN "merchantAccountId" TEXT;
ALTER TABLE "purchases" ADD COLUMN "paymentChallenge" TEXT;
ALTER TABLE "purchases" ADD COLUMN "requestCiphertext" TEXT;
ALTER TABLE "purchases" ADD COLUMN "tokenCiphertext" TEXT;
