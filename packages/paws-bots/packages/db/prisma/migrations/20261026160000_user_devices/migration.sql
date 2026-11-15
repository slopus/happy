-- Additive: the previous release never reads these tables.
CREATE TABLE "user_devices" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "user_devices_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "user_devices_userId_fkey" FOREIGN KEY ("userId")
      REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "user_devices_tokenHash_key" ON "user_devices"("tokenHash");
CREATE INDEX "user_devices_userId_revokedAt_idx" ON "user_devices"("userId", "revokedAt");

CREATE TABLE "user_device_connections" (
    "deviceId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_device_connections_pkey" PRIMARY KEY ("deviceId"),
    CONSTRAINT "user_device_connections_deviceId_fkey" FOREIGN KEY ("deviceId")
      REFERENCES "user_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "user_device_connections_connectionId_key" ON "user_device_connections"("connectionId");
CREATE INDEX "user_device_connections_heartbeatAt_idx" ON "user_device_connections"("heartbeatAt");

-- Like sessions, these are read only as system and always filtered by owner, so no row policies.
