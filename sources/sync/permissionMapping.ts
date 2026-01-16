import type { PermissionMode } from './permissionTypes';
import type { AgentType } from './modelOptions';

function isCodexLike(agent: AgentType) {
    return agent === 'codex' || agent === 'gemini';
}

export function mapPermissionModeAcrossAgents(
    mode: PermissionMode,
    from: AgentType,
    to: AgentType,
): PermissionMode {
    if (from === to) return mode;

    const fromCodexLike = isCodexLike(from);
    const toCodexLike = isCodexLike(to);

    // Codex <-> Gemini uses the same permission mode set.
    if (fromCodexLike && toCodexLike) return mode;

    if (!fromCodexLike && toCodexLike) {
        // Claude -> Codex/Gemini
        switch (mode) {
            case 'bypassPermissions':
                return 'yolo';
            case 'plan':
                return 'safe-yolo';
            case 'acceptEdits':
                return 'safe-yolo';
            case 'default':
                return 'default';
            default:
                return 'default';
        }
    }

    // Codex/Gemini -> Claude
    switch (mode) {
        case 'yolo':
            return 'bypassPermissions';
        case 'safe-yolo':
            return 'plan';
        case 'read-only':
            return 'default';
        case 'default':
            return 'default';
        default:
            return 'default';
    }
}
