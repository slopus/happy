import type { CodexSessionConfig } from './types';

type CodexApprovalPolicy = NonNullable<CodexSessionConfig['approval-policy']>;
type CodexSandboxMode = NonNullable<CodexSessionConfig['sandbox']>;

export function resolveCodexExecutionPolicy(
    permissionMode: import('@/api/types').PermissionMode,
    sandboxManagedByHappy: boolean,
): { approvalPolicy: CodexApprovalPolicy; sandbox: CodexSandboxMode } {
    if (sandboxManagedByHappy) {
        return {
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        };
    }

    const approvalPolicy: CodexApprovalPolicy = (() => {
        switch (permissionMode) {
            // Codex native modes
            case 'default': return 'untrusted';                    // Ask for non-trusted commands
            case 'read-only': return 'never';                      // Never ask, read-only enforced by sandbox
            case 'safe-yolo': return 'on-failure';                 // Auto-run, ask only on failure
            case 'yolo': return 'on-failure';                      // Auto-run, ask only on failure
            // Defensive fallback for Claude-specific modes (backward compatibility)
            case 'bypassPermissions': return 'on-failure';         // Full access: map to yolo behavior
            case 'acceptEdits': return 'on-request';               // Let model decide (closest to auto-approve edits)
            case 'plan': return 'untrusted';                       // Conservative: ask for non-trusted
            default: return 'untrusted';                           // Safe fallback
        }
    })();

    const sandbox: CodexSandboxMode = (() => {
        switch (permissionMode) {
            // Codex native modes
            case 'default': return 'workspace-write';              // Can write in workspace
            case 'read-only': return 'read-only';                  // Read-only filesystem
            case 'safe-yolo': return 'workspace-write';            // Can write in workspace
            case 'yolo': return 'danger-full-access';              // Full system access
            // Defensive fallback for Claude-specific modes
            case 'bypassPermissions': return 'danger-full-access'; // Full access: map to yolo
            case 'acceptEdits': return 'workspace-write';          // Can edit files in workspace
            case 'plan': return 'workspace-write';                 // Can write for planning
            default: return 'workspace-write';                     // Safe default
        }
    })();

    return { approvalPolicy, sandbox };
}
