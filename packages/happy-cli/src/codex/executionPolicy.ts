import type { ApprovalPolicy, SandboxMode } from './codexAppServerTypes';
import type { PermissionMode } from '@/api/types';

const REMOTE_CODEX_PERMISSION_MODES: readonly PermissionMode[] = [
    'default',
    'acceptEdits',
    'read-only',
    'safe-yolo',
    'yolo',
];

export function isRemoteCodexPermissionMode(value: string | null | undefined): value is PermissionMode {
    return typeof value === 'string'
        && REMOTE_CODEX_PERMISSION_MODES.includes(value as PermissionMode);
}

export function resolveCodexExecutionPolicy(
    permissionMode: PermissionMode,
    sandboxManagedByHappy: boolean,
): { approvalPolicy?: ApprovalPolicy; sandbox?: SandboxMode } {
    // The current native protocol no longer accepts on-failure. Keep the
    // legacy mode recognizable, but never silently replace its permission tier.
    if (permissionMode === 'safe-yolo') {
        throw new Error('Codex automatic approval mode (safe-yolo) is not supported by this runtime. Choose confirmation or full access explicitly.');
    }

    if (sandboxManagedByHappy) {
        return {
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        };
    }

    if (permissionMode === 'default') {
        return {};
    }

    const approvalPolicy: ApprovalPolicy = (() => {
        switch (permissionMode) {
            // Codex native modes
            case 'read-only': return 'never';                      // Never ask, read-only enforced by sandbox
            case 'yolo': return 'never';                           // Full YOLO: never interrupt for approvals
            // Defensive fallback for Claude-specific modes (backward compatibility)
            case 'bypassPermissions': return 'never';              // Full access: map to yolo behavior
            case 'acceptEdits': return 'on-request';               // Let model decide (closest to auto-approve edits)
            case 'plan': return 'never';                           // Plan mode should not pause for write approvals
            default: return 'untrusted';                           // Safe fallback
        }
    })();

    const sandbox: SandboxMode = (() => {
        switch (permissionMode) {
            // Codex native modes
            case 'read-only': return 'read-only';                  // Read-only filesystem
            case 'yolo': return 'danger-full-access';              // Full system access
            // Defensive fallback for Claude-specific modes
            case 'bypassPermissions': return 'danger-full-access'; // Full access: map to yolo
            case 'acceptEdits': return 'workspace-write';          // Can edit files in workspace
            case 'plan': return 'read-only';                       // Planning should not modify files
            default: return 'workspace-write';                     // Safe default
        }
    })();

    return { approvalPolicy, sandbox };
}
