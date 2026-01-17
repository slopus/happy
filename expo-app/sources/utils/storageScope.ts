export const EXPO_PUBLIC_STORAGE_SCOPE_ENV_VAR = 'EXPO_PUBLIC_HAPPY_STORAGE_SCOPE';

/**
 * Returns a sanitized storage scope suitable for identifiers/keys, or null.
 *
 * Notes:
 * - This is intentionally conservative (stable, URL/key friendly).
 * - If unset/empty, callers should behave exactly as they did before (no scoping).
 */
export function normalizeStorageScope(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;

    // Keep only safe characters to avoid backend/storage quirks (keychain, MMKV id, etc.)
    // Replace everything else with '_' for stability.
    const sanitized = trimmed.replace(/[^a-zA-Z0-9._-]/g, '_');
    const collapsed = sanitized.replace(/_+/g, '_');
    const clamped = collapsed.slice(0, 64);
    return clamped || null;
}

export function readStorageScopeFromEnv(
    env: Record<string, string | undefined> = process.env,
): string | null {
    return normalizeStorageScope(env[EXPO_PUBLIC_STORAGE_SCOPE_ENV_VAR]);
}

export function scopedStorageId(baseId: string, scope: string | null): string {
    // Must be compatible with all underlying stores (SecureStore keys are especially strict).
    return scope ? `${baseId}__${scope}` : baseId;
}
