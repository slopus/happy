import type { Settings } from './settings';

const WEB_FLAG_KEY = 'HAPPY_DEBUG_SETTINGS_SYNC';

function readWebFlag(): boolean {
    try {
        if (typeof window === 'undefined') return false;
        const v = window.localStorage?.getItem(WEB_FLAG_KEY);
        if (!v) return false;
        const normalized = v.trim().toLowerCase();
        return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
    } catch {
        return false;
    }
}

/**
 * Opt-in debug switch for verbose settings sync logging.
 *
 * - Web: `localStorage.setItem('HAPPY_DEBUG_SETTINGS_SYNC', '1')` then reload
 * - Native: set env `EXPO_PUBLIC_HAPPY_DEBUG_SETTINGS_SYNC=1`
 */
export function isSettingsSyncDebugEnabled(env: Record<string, string | undefined> = process.env): boolean {
    const fromEnv = env.EXPO_PUBLIC_HAPPY_DEBUG_SETTINGS_SYNC;
    if (typeof fromEnv === 'string') {
        const n = fromEnv.trim().toLowerCase();
        if (n === '1' || n === 'true' || n === 'yes' || n === 'on') return true;
    }
    // Avoid importing react-native here (breaks node/vitest due to Flow syntax in RN entrypoint).
    // Web-only fallback: allow toggling via localStorage.
    return typeof window !== 'undefined' ? readWebFlag() : false;
}

function safeKeys(obj: unknown): string[] {
    if (!obj || typeof obj !== 'object') return [];
    return Object.keys(obj as Record<string, unknown>);
}

export function summarizeSettingsDelta(delta: Partial<Settings>): Record<string, unknown> {
    const keys = safeKeys(delta).sort();
    const out: Record<string, unknown> = { keys };

    if ('secrets' in delta) {
        const arr = (delta as any).secrets;
        if (Array.isArray(arr)) {
            out.secrets = {
                count: arr.length,
                entries: arr.slice(0, 20).map((k: any) => ({
                    id: typeof k?.id === 'string' ? k.id : null,
                    name: typeof k?.name === 'string' ? k.name : null,
                    hasValue: typeof k?.encryptedValue?.value === 'string' && k.encryptedValue.value.length > 0,
                    hasEncryptedValue: Boolean(k?.encryptedValue?._isSecretValue === true && k?.encryptedValue?.encryptedValue && typeof k.encryptedValue.encryptedValue.c === 'string' && k.encryptedValue.encryptedValue.c.length > 0),
                })),
            };
        } else {
            out.secrets = { type: typeof arr };
        }
    }

    if ('secretBindingsByProfileId' in delta) {
        const m = (delta as any).secretBindingsByProfileId;
        out.secretBindingsByProfileId = {
            keys: safeKeys(m).slice(0, 50).sort(),
        };
    }

    return out;
}

export function summarizeSettings(settings: Settings, extra?: { version?: number | null }): Record<string, unknown> {
    return {
        ...(extra ? extra : {}),
        schemaVersion: (settings as any)?.schemaVersion ?? null,
        secrets: {
            count: Array.isArray((settings as any)?.secrets) ? (settings as any).secrets.length : null,
            anyMissingValue: Array.isArray((settings as any)?.secrets)
                ? (settings as any).secrets.some((k: any) => !(
                    (typeof k?.encryptedValue?.value === 'string' && k.encryptedValue.value.length > 0) ||
                    (k?.encryptedValue?._isSecretValue === true && k?.encryptedValue?.encryptedValue && typeof k.encryptedValue.encryptedValue.c === 'string' && k.encryptedValue.encryptedValue.c.length > 0)
                ))
                : null,
        },
        profilesCount: Array.isArray((settings as any)?.profiles) ? (settings as any).profiles.length : null,
    };
}

export function dbgSettings(
    label: string,
    data?: Record<string, unknown>,
    opts?: { force?: boolean; env?: Record<string, string | undefined> }
) {
    const enabled = isSettingsSyncDebugEnabled(opts?.env);
    if (!enabled && !opts?.force) return;
    try {
        // eslint-disable-next-line no-console
        console.log(`[settings-sync] ${label}`, data ?? {});
    } catch {
        // ignore
    }
}

