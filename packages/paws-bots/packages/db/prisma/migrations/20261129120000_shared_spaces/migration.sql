-- Shared spaces: invite links and message authors. Additive only, so the
-- previous release keeps working while both run during a deploy.

ALTER TABLE "messages" ADD COLUMN "authorUserId" TEXT;

CREATE TABLE "space_invites" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "acceptedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "space_invites_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "space_invites_tokenHash_key" ON "space_invites"("tokenHash");
CREATE INDEX "space_invites_spaceId_createdAt_idx" ON "space_invites"("spaceId", "createdAt");

ALTER TABLE "space_invites" ADD CONSTRAINT "space_invites_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "space_invites" ADD CONSTRAINT "space_invites_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Who holds user control of a computer, so one person never gets another's lease.
ALTER TABLE "computers" ADD COLUMN "controlUserId" TEXT;
