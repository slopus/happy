import type { Session } from './storageTypes';
import type { PermissionModeKey } from '@/components/PermissionModeSelector';

function isSandboxEnabled(metadata: Session['metadata'] | null | undefined): boolean {
    const sandbox = metadata?.sandbox;
    return !!sandbox && typeof sandbox === 'object' && (sandbox as { enabled?: unknown }).enabled === true;
}

const KNOWN_PERMISSION_MODES: ReadonlySet<string> = new Set([
    'default',
    'acceptEdits',
    'bypassPermissions',
    'plan',
    'read-only',
    'safe-yolo',
    'yolo',
]);

function resolveInitialPermissionMode(metadata: Session['metadata'] | null | undefined): PermissionModeKey | null {
    if (isSandboxEnabled(metadata)) {
        return 'bypassPermissions';
    }
    const initial = metadata?.initialPermissionMode;
    if (typeof initial === 'string' && KNOWN_PERMISSION_MODES.has(initial)) {
        return initial;
    }
    if (metadata?.dangerouslySkipPermissions) {
        return 'bypassPermissions';
    }
    return null;
}

export function resolveMessageModeMeta(
    session: Pick<Session, 'permissionMode' | 'modelMode' | 'metadata'>,
): { permissionMode: PermissionModeKey; model: string | null } {
    const initialMode = resolveInitialPermissionMode(session.metadata);
    const permissionMode: PermissionModeKey =
        session.permissionMode && session.permissionMode !== 'default'
            ? session.permissionMode
            : (initialMode ?? 'default');

    const modelMode = session.modelMode || 'default';
    const model = modelMode !== 'default' ? modelMode : null;

    return {
        permissionMode,
        model,
    };
}
