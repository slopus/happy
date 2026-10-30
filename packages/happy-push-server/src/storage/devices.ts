import type { ApnsEnvironment, DeviceMetadata, Platform } from '@/schema';
import { mintDeviceId } from '@/token';

export interface DeviceRecord {
    id: string;
    appId: string;
    platform: Platform;
    environment: ApnsEnvironment;
    nativeToken: string;
    active: boolean;
}

interface DeviceRow {
    id: string;
    app_id: string;
    platform: Platform;
    environment: ApnsEnvironment;
    native_token: string;
    active: number;
}

export interface UpsertDeviceInput {
    appId: string;
    deviceId: string;
    platform: Platform;
    environment: ApnsEnvironment;
    nativeToken: string;
    /** Omitted metadata keeps whatever the row already has. */
    metadata?: DeviceMetadata;
}

/**
 * Registers or refreshes an install and returns its stable id.
 *
 * The (appId, deviceId) row keeps the id it was first minted with: token
 * rotation, new metadata, and re-registering after unregister all update the
 * same row. If the native token is currently live on a *different* install
 * (reinstall with a new deviceId, restored backup), that other install is
 * deactivated first, so one physical token is never delivered to twice.
 */
export async function upsertDevice(db: D1Database, input: UpsertDeviceInput, now: number): Promise<string> {
    const metadata = input.metadata ? JSON.stringify(input.metadata) : null;
    const supersede = db.prepare(
        `UPDATE devices SET active = 0, inactive_reason = 'superseded', updated_at = ?1
         WHERE app_id = ?2 AND platform = ?3 AND native_token = ?4 AND device_id <> ?5 AND active = 1`
    ).bind(now, input.appId, input.platform, input.nativeToken, input.deviceId);
    const upsert = db.prepare(
        `INSERT INTO devices (id, app_id, device_id, platform, environment, native_token, metadata, active, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, COALESCE(?7, '{}'), 1, ?8, ?8)
         ON CONFLICT (app_id, device_id) DO UPDATE SET
             platform = excluded.platform,
             environment = excluded.environment,
             native_token = excluded.native_token,
             metadata = CASE WHEN ?7 IS NULL THEN devices.metadata ELSE excluded.metadata END,
             active = 1,
             inactive_reason = NULL,
             last_error = NULL,
             last_error_at = NULL,
             updated_at = excluded.updated_at
         RETURNING id`
    ).bind(mintDeviceId(), input.appId, input.deviceId, input.platform, input.environment, input.nativeToken, metadata, now);

    const run = async () => {
        const [, result] = await db.batch<{ id: string }>([supersede, upsert]);
        const id = result?.results[0]?.id;
        if (!id) {
            throw new Error('device upsert returned no id');
        }
        return id;
    };

    try {
        return await run();
    } catch (error) {
        // Two installs registering the same native token at the same instant
        // can both pass the supersede step; the partial unique index rejects
        // the loser, and a retry supersedes the winner.
        if (isUniqueViolation(error)) {
            return await run();
        }
        throw error;
    }
}

/** Marks an install inactive. Its id stays reserved for re-registration. */
export async function deactivateDevice(db: D1Database, appId: string, deviceId: string, now: number): Promise<boolean> {
    const result = await db.prepare(
        `UPDATE devices SET active = 0, inactive_reason = 'unregistered', updated_at = ?1
         WHERE app_id = ?2 AND device_id = ?3`
    ).bind(now, appId, deviceId).run();
    return (result.meta.changes ?? 0) > 0;
}

export async function findDevices(db: D1Database, ids: readonly string[]): Promise<Map<string, DeviceRecord>> {
    const devices = new Map<string, DeviceRecord>();
    if (ids.length === 0) {
        return devices;
    }
    const placeholders = ids.map(() => '?').join(', ');
    const { results } = await db.prepare(
        `SELECT id, app_id, platform, environment, native_token, active FROM devices WHERE id IN (${placeholders})`
    ).bind(...ids).all<DeviceRow>();
    for (const row of results) {
        devices.set(row.id, {
            id: row.id,
            appId: row.app_id,
            platform: row.platform,
            environment: row.environment,
            nativeToken: row.native_token,
            active: row.active === 1,
        });
    }
    return devices;
}

export type DeliveryRecord =
    | { kind: 'sent'; device: DeviceRecord }
    | { kind: 'failed'; device: DeviceRecord; error: string }
    /** The provider says the native token is dead; the install goes inactive. */
    | { kind: 'unregistered'; device: DeviceRecord; error: string };

export async function recordDeliveries(db: D1Database, deliveries: readonly DeliveryRecord[], now: number): Promise<void> {
    if (deliveries.length === 0) {
        return;
    }
    const statements = deliveries.map((delivery) => {
        switch (delivery.kind) {
            case 'sent':
                return db.prepare('UPDATE devices SET last_sent_at = ?1 WHERE id = ?2').bind(now, delivery.device.id);
            case 'failed':
                return db.prepare('UPDATE devices SET last_error = ?1, last_error_at = ?2 WHERE id = ?3')
                    .bind(delivery.error, now, delivery.device.id);
            case 'unregistered':
                // Guarded on the token we actually sent to: if the app
                // re-registered a fresh token mid-send, leave it alone.
                return db.prepare(
                    `UPDATE devices SET active = 0, inactive_reason = ?1, last_error = ?1, last_error_at = ?2, updated_at = ?2
                     WHERE id = ?3 AND native_token = ?4`
                ).bind(delivery.error, now, delivery.device.id, delivery.device.nativeToken);
        }
    });
    await db.batch(statements);
}

function isUniqueViolation(error: unknown): boolean {
    return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}
