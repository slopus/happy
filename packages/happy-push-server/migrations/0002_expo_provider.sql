-- Adds the delivery provider. An install now holds either a native token
-- (APNs/FCM) or an Expo push token whose sends are forwarded to Expo, so the
-- token column becomes `push_token` and `provider` says how to deliver it.
-- SQLite cannot change CHECK constraints in place, so the table is rebuilt.
CREATE TABLE devices_next (
    id TEXT PRIMARY KEY NOT NULL,
    app_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
    provider TEXT NOT NULL CHECK (provider IN ('apns', 'fcm', 'expo')),
    -- APNs host selection; always 'production' for fcm and expo.
    environment TEXT NOT NULL CHECK (environment IN ('production', 'development')),
    push_token TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    -- Why the row went inactive: 'unregistered', 'superseded', or the provider reason.
    inactive_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_sent_at INTEGER,
    last_error TEXT,
    last_error_at INTEGER,
    -- Native tokens are platform-specific; Expo tokens exist for both.
    CHECK (provider = 'expo' OR (provider = 'apns') = (platform = 'ios'))
);

INSERT INTO devices_next (
    id, app_id, device_id, platform, provider, environment, push_token, metadata, active,
    inactive_reason, created_at, updated_at, last_sent_at, last_error, last_error_at
)
SELECT
    id, app_id, device_id, platform, CASE platform WHEN 'ios' THEN 'apns' ELSE 'fcm' END, environment, native_token, metadata, active,
    inactive_reason, created_at, updated_at, last_sent_at, last_error, last_error_at
FROM devices;

DROP TABLE devices;
ALTER TABLE devices_next RENAME TO devices;

CREATE UNIQUE INDEX devices_app_device ON devices (app_id, device_id);

-- A push token may only be live on one install, so a token that moves to a
-- new device id can never be delivered twice. Keyed on provider rather than
-- platform: one Expo token is one install whatever platform it reports.
CREATE UNIQUE INDEX devices_active_push_token ON devices (app_id, provider, push_token) WHERE active = 1;

CREATE INDEX devices_push_token ON devices (push_token);
