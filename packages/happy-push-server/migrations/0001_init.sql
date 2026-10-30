-- One row per app install. `id` is the public HappyPushToken[...] body and never
-- changes once minted for an (app_id, device_id) pair.
CREATE TABLE devices (
    id TEXT PRIMARY KEY NOT NULL,
    app_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
    environment TEXT NOT NULL CHECK (environment IN ('production', 'development')),
    native_token TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    -- Why the row went inactive: 'unregistered', 'superseded', or the provider reason.
    inactive_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_sent_at INTEGER,
    last_error TEXT,
    last_error_at INTEGER
);

CREATE UNIQUE INDEX devices_app_device ON devices (app_id, device_id);

-- A native token may only be live on one install, so a token that moves to a
-- new device id can never be delivered twice.
CREATE UNIQUE INDEX devices_active_native_token ON devices (app_id, platform, native_token) WHERE active = 1;

CREATE INDEX devices_native_token ON devices (native_token);
