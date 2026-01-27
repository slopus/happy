const VALID_ENV_VAR_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function isValidEnvVarKey(key: string): boolean {
    return VALID_ENV_VAR_KEY.test(key) && !FORBIDDEN_KEYS.has(key);
}

export function sanitizeEnvVarRecord(raw: unknown): Record<string, string> {
    const out: Record<string, string> = Object.create(null);
    if (!raw || typeof raw !== 'object') return out;

    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof k !== 'string' || !isValidEnvVarKey(k)) continue;
        if (typeof v !== 'string') continue;
        out[k] = v;
    }
    return out;
}

export function validateEnvVarRecordStrict(raw: unknown): { ok: true; env: Record<string, string> } | { ok: false; error: string } {
    if (!raw || typeof raw !== 'object') {
        return { ok: true, env: Object.create(null) };
    }

    const env: Record<string, string> = Object.create(null);
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof k !== 'string' || !isValidEnvVarKey(k)) {
            return { ok: false, error: `Invalid env var key: "${String(k)}"` };
        }
        if (typeof v !== 'string') {
            return { ok: false, error: `Invalid env var value for "${k}": expected string` };
        }
        env[k] = v;
    }

    return { ok: true, env };
}

