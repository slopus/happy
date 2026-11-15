-- Vault items get a title people choose and a note on when to use them. Additive: the previous
-- release ignores both columns.
ALTER TABLE "vault_credentials" ADD COLUMN "title" TEXT NOT NULL DEFAULT '';
ALTER TABLE "vault_credentials" ADD COLUMN "note" TEXT NOT NULL DEFAULT '';
