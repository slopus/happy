/**
 * Resolve the harness identity used by a session avatar badge.
 *
 * A Rig session is Happy's own harness even when its selected provider is
 * Codex or Claude, so the client identity always wins over provider/flavor
 * metadata. Only the active harnesses have badges; retired and unknown
 * flavors stay badge-free.
 */
export type AvatarHarnessIcon = 'claude' | 'codex' | 'agy' | 'rig';

const ACTIVE_HARNESS_ICONS: ReadonlySet<string> = new Set([
    'claude',
    'codex',
    'agy',
]);

export function resolveAvatarHarness(
    flavor?: string | null,
    clientId?: string | null,
): AvatarHarnessIcon | null {
    if (clientId === 'rig') return 'rig';
    if (flavor == null || !ACTIVE_HARNESS_ICONS.has(flavor)) return null;
    return flavor as Exclude<AvatarHarnessIcon, 'rig'>;
}