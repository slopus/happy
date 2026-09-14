ALTER TABLE "Session"
    ADD COLUMN "avatarRef" TEXT,
    ADD COLUMN "avatarPreview" TEXT,
    ADD COLUMN "avatarVersion" INTEGER NOT NULL DEFAULT 0;