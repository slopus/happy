import type { DelegationAgent } from '@slopus/happy-wire';

/** Cross-runtime restrictions must have an equivalent policy, rather than silently widening access. */
export function delegationPermissionMode(parent: { agent: DelegationAgent; permissionMode: string }, target: DelegationAgent): string {
    if (parent.agent === target) {
        if (target === 'antigravity') {
            if (parent.permissionMode === 'default' || parent.permissionMode === 'bypassPermissions') return parent.permissionMode;
        } else if (['default', 'acceptEdits', 'read-only', 'safe-yolo', 'yolo', 'bypassPermissions', 'plan'].includes(parent.permissionMode)) return parent.permissionMode;
        throw new Error('The parent permission policy is not supported by this delegated agent');
    }
    if (!['yolo', 'bypassPermissions'].includes(parent.permissionMode)) {
        throw new Error('Cross-agent delegation requires an equivalent full-access policy. The current restricted policy cannot be transferred to the other runtime; change the parent policy explicitly before delegating.');
    }
    return target === 'antigravity' ? 'bypassPermissions' : 'yolo';
}
