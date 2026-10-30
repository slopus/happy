import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const migration = (name: string) => readFileSync(join(import.meta.dirname, '..', 'migrations', name), 'utf8');

describe('0002_expo_provider', () => {
    it('carries existing installs over with their native provider', () => {
        const db = new DatabaseSync(':memory:');
        db.exec(migration('0001_init.sql'));
        const insert = db.prepare(
            `INSERT INTO devices (id, app_id, device_id, platform, environment, native_token, metadata, active, inactive_reason, created_at, updated_at, last_sent_at)
             VALUES (?, 'com.ex3ndr.happy', ?, ?, ?, ?, '{"appVersion":"1"}', ?, ?, 1, 2, 3)`
        );
        insert.run('iosid', 'ios-device', 'ios', 'development', 'a'.repeat(64), 1, null);
        insert.run('androidid', 'android-device', 'android', 'production', 'fcm-token', 0, 'unregistered');

        db.exec(migration('0002_expo_provider.sql'));

        expect(db.prepare('SELECT * FROM devices ORDER BY id').all().map((row) => ({ ...row }))).toEqual([
            {
                id: 'androidid', app_id: 'com.ex3ndr.happy', device_id: 'android-device', platform: 'android', provider: 'fcm',
                environment: 'production', push_token: 'fcm-token', metadata: '{"appVersion":"1"}', active: 0,
                inactive_reason: 'unregistered', created_at: 1, updated_at: 2, last_sent_at: 3, last_error: null, last_error_at: null,
            },
            {
                id: 'iosid', app_id: 'com.ex3ndr.happy', device_id: 'ios-device', platform: 'ios', provider: 'apns',
                environment: 'development', push_token: 'a'.repeat(64), metadata: '{"appVersion":"1"}', active: 1,
                inactive_reason: null, created_at: 1, updated_at: 2, last_sent_at: 3, last_error: null, last_error_at: null,
            },
        ]);
        const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'devices' AND sql IS NOT NULL ORDER BY name").all();
        expect(indexes.map((row) => row.name)).toEqual(['devices_active_push_token', 'devices_app_device', 'devices_push_token']);
    });

    it('rejects a native provider on the wrong platform', () => {
        const db = new DatabaseSync(':memory:');
        db.exec(migration('0001_init.sql'));
        db.exec(migration('0002_expo_provider.sql'));
        const insert = db.prepare(
            `INSERT INTO devices (id, app_id, device_id, platform, provider, environment, push_token, created_at, updated_at)
             VALUES (?, 'app', ?, ?, ?, 'production', 'tok', 0, 0)`
        );
        expect(() => insert.run('a', 'd1', 'android', 'apns')).toThrow(/CHECK constraint failed/);
        expect(() => insert.run('b', 'd2', 'ios', 'fcm')).toThrow(/CHECK constraint failed/);
        expect(() => insert.run('c', 'd3', 'android', 'expo')).not.toThrow();
        expect(() => insert.run('d', 'd4', 'ios', 'expo')).toThrow(/UNIQUE constraint failed/);
    });
});
