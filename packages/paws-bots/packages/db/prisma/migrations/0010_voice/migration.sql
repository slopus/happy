-- Voice: per-user provider credentials (key stays encrypted) and per-bot voice/auto-speak.

CREATE TABLE "user_voice_credentials" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "secretId" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "voiceId" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_voice_credentials_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "user_voice_credentials_userId_workspaceId_idx"
ON "user_voice_credentials"("userId", "workspaceId");

ALTER TABLE "user_voice_credentials"
ADD CONSTRAINT "user_voice_credentials_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "bots" ADD COLUMN "voiceId" TEXT;
ALTER TABLE "bots" ADD COLUMN "autoSpeak" BOOLEAN NOT NULL DEFAULT false;
