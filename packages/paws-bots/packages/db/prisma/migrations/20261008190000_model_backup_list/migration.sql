-- CreateTable
CREATE TABLE "space_backup_models" (
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "space_backup_models_pkey" PRIMARY KEY ("spaceId", "userId", "position")
);

-- CreateIndex
CREATE UNIQUE INDEX "space_backup_models_spaceId_userId_provider_modelId_key"
    ON "space_backup_models"("spaceId", "userId", "provider", "modelId");

-- AddForeignKey
ALTER TABLE "space_backup_models"
    ADD CONSTRAINT "space_backup_models_spaceId_userId_fkey"
    FOREIGN KEY ("spaceId", "userId") REFERENCES "space_members"("spaceId", "userId")
    ON DELETE CASCADE ON UPDATE CASCADE;
