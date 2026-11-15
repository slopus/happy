-- More sites a saved login fills on. Additive: existing logins keep only their own site, and the
-- previous release ignores the column.
ALTER TABLE "vault_credentials" ADD COLUMN "alsoOn" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- When a run used up its tries of a login's authenticator codes, so later runs type none until the
-- login is saved again. Nullable, so existing logins and the previous release are unaffected.
ALTER TABLE "vault_credentials" ADD COLUMN "codesStoppedAt" TIMESTAMP(3);
