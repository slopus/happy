-- CreateTable
CREATE TABLE "AIService" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AIService_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIServiceRevision" (
    "serviceId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "accountFingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIServiceRevision_pkey" PRIMARY KEY ("serviceId","revision")
);

-- CreateTable
CREATE TABLE "AIServiceApplication" (
    "appId" TEXT NOT NULL,
    "policy" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AIServiceApplication_pkey" PRIMARY KEY ("appId")
);

-- CreateTable
CREATE TABLE "AIServiceAuthorization" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "scope" JSONB NOT NULL,
    "allowModelOverride" BOOLEAN NOT NULL DEFAULT false,
    "allowReasoningOverride" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIServiceAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIServiceBinding" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "authorizationId" TEXT,
    "snapshot" JSONB NOT NULL,
    "accountFingerprint" TEXT NOT NULL,
    "capabilityObservedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIServiceBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIServiceCapabilitySnapshot" (
    "ownerId" TEXT NOT NULL,
    "targetKey" TEXT NOT NULL,
    "catalog" JSONB NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AIServiceCapabilitySnapshot_pkey" PRIMARY KEY ("ownerId","targetKey")
);

-- CreateIndex
CREATE INDEX "AIService_ownerId_createdAt_idx" ON "AIService"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "AIServiceAuthorization_ownerId_appId_serviceId_idx" ON "AIServiceAuthorization"("ownerId", "appId", "serviceId");

-- CreateIndex
CREATE INDEX "AIServiceBinding_ownerId_appId_serviceId_idx" ON "AIServiceBinding"("ownerId", "appId", "serviceId");

-- AddForeignKey
ALTER TABLE "AIService" ADD CONSTRAINT "AIService_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIServiceRevision" ADD CONSTRAINT "AIServiceRevision_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "AIService"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIServiceAuthorization" ADD CONSTRAINT "AIServiceAuthorization_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIServiceAuthorization" ADD CONSTRAINT "AIServiceAuthorization_appId_fkey" FOREIGN KEY ("appId") REFERENCES "AIServiceApplication"("appId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIServiceAuthorization" ADD CONSTRAINT "AIServiceAuthorization_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "AIService"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIServiceBinding" ADD CONSTRAINT "AIServiceBinding_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIServiceBinding" ADD CONSTRAINT "AIServiceBinding_appId_fkey" FOREIGN KEY ("appId") REFERENCES "AIServiceApplication"("appId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIServiceBinding" ADD CONSTRAINT "AIServiceBinding_serviceId_revision_fkey" FOREIGN KEY ("serviceId", "revision") REFERENCES "AIServiceRevision"("serviceId", "revision") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIServiceBinding" ADD CONSTRAINT "AIServiceBinding_authorizationId_fkey" FOREIGN KEY ("authorizationId") REFERENCES "AIServiceAuthorization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIServiceCapabilitySnapshot" ADD CONSTRAINT "AIServiceCapabilitySnapshot_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Revisions and bindings are append-only. Roll back server code without deleting data.
CREATE FUNCTION ai_service_reject_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'AI service records are immutable';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ai_service_revision_immutable BEFORE UPDATE OR DELETE ON "AIServiceRevision"
    FOR EACH ROW EXECUTE FUNCTION ai_service_reject_mutation();
CREATE TRIGGER ai_service_binding_immutable BEFORE UPDATE OR DELETE ON "AIServiceBinding"
    FOR EACH ROW EXECUTE FUNCTION ai_service_reject_mutation();

INSERT INTO "AIServiceApplication" ("appId", "policy", "updatedAt") VALUES (
    'relationship-advisor',
    '{"appId":"relationship-advisor","name":"狗头军师","origins":["https://advisor.paws.rodeo"],"capabilities":["chat","images"],"businessPrompt":{"id":"relationship-advisor","version":"1"}}',
    CURRENT_TIMESTAMP
);
