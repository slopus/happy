-- Additive vault access settings. The legacy access guard migration hides restricted items
-- from older runtime connections while keeping unrestricted items usable.
ALTER TABLE "vault_credentials" ADD COLUMN "policy" TEXT NOT NULL DEFAULT 'allow';
