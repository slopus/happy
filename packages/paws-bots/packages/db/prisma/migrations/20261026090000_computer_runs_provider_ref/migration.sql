-- The provider's sandbox id, so runs can be matched with the provider's own usage and billing.
ALTER TABLE "computer_runs" ADD COLUMN "providerRef" TEXT;
