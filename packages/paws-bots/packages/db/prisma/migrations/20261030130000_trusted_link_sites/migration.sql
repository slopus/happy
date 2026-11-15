-- Additive: the previous release never reads this table.
CREATE TABLE "trusted_link_sites" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "site" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trusted_link_sites_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "trusted_link_sites_userId_site_key" ON "trusted_link_sites"("userId", "site");

ALTER TABLE "trusted_link_sites" ADD CONSTRAINT "trusted_link_sites_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Same policies as user_model_credentials (20261021140000_row_level_security).
ALTER TABLE "trusted_link_sites" ENABLE ROW LEVEL SECURITY;
CREATE POLICY trusted_link_sites_tenant ON "trusted_link_sites"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY trusted_link_sites_system ON "trusted_link_sites"
  USING (current_setting('app.rls_bypass', true) = 'on');
