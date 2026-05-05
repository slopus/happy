import type { Session } from './storageTypes';
import type { PermissionModeKey } from '@/components/PermissionModeSelector';

function isSandboxEnabled(metadata: Session['metadata'] | null | undefined): boolean {
    const sandbox = metadata?.sandbox;
    return !!sandbox && typeof sandbox === 'object' && (sandbox as { enabled?: unknown }).enabled === true;
}

export function resolveMessageModeMeta(
    session: Pick<Session, 'permissionMode' | 'modelMode' | 'metadata' | 'effortLevel'>,
): { permissionMode: PermissionModeKey; model: string | null; effort: string | null } {
    const sandboxEnabled = isSandboxEnabled(session.metadata);
    const permissionMode: PermissionModeKey =
        session.permissionMode && session.permissionMode !== 'default'
            ? session.permissionMode
            : (sandboxEnabled ? 'bypassPermissions' : 'default');

    const modelMode = session.modelMode || 'default';
    const model = modelMode !== 'default' ? modelMode : null;

    // Effort flows through user-message meta: CLI runners (claude/codex) read
    // it on each turn and pass through to the SDK call. Null tells the runner
    // to keep its own default — we only pin a level when the user explicitly
    // chose one in the UI.
    const effort = session.effortLevel ?? null;

    return {
        permissionMode,
        model,
        effort,
    };
}
