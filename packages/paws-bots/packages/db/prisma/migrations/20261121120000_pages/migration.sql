-- Additive: older releases never read or write these tables.
CREATE TABLE "pages" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT,
    "groupId" TEXT,
    "title" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "shareTokenHash" TEXT,
    "shareSecretId" TEXT,
    "pinnedAt" TIMESTAMP(3),
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "page_versions" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pages_shareTokenHash_key" ON "pages"("shareTokenHash");

CREATE UNIQUE INDEX "pages_shareSecretId_key" ON "pages"("shareSecretId");

CREATE INDEX "pages_spaceId_userId_updatedAt_idx" ON "pages"("spaceId", "userId", "updatedAt");

CREATE INDEX "pages_botId_idx" ON "pages"("botId");

CREATE INDEX "pages_groupId_idx" ON "pages"("groupId");

CREATE UNIQUE INDEX "page_versions_pageId_version_key" ON "page_versions"("pageId", "version");

ALTER TABLE "pages" ADD CONSTRAINT "pages_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "pages" ADD CONSTRAINT "pages_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "pages" ADD CONSTRAINT "pages_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "pages" ADD CONSTRAINT "pages_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "chat_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "pages" ADD CONSTRAINT "pages_shareSecretId_fkey" FOREIGN KEY ("shareSecretId") REFERENCES "secrets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A page and its versions belong to one user in one Space; the public share read is a
-- named system lookup by token hash.
ALTER TABLE "pages" ENABLE ROW LEVEL SECURITY;
CREATE POLICY pages_tenant ON "pages"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
     AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY pages_system ON "pages"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "page_versions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY page_versions_tenant ON "page_versions"
  USING (EXISTS (
    SELECT 1 FROM "pages" p
    WHERE p."id" = "page_versions"."pageId"
      AND p."spaceId" = NULLIF(current_setting('app.space_id', true), '')
      AND p."userId" = NULLIF(current_setting('app.user_id', true), '')
  ));
CREATE POLICY page_versions_system ON "page_versions"
  USING ((SELECT app_rls_bypass()));
