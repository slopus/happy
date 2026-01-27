import type { PermissionMode } from './permissionTypes';
import type { AgentType } from './modelOptions';
import { getAgentCore } from '@/agents/catalog';

function isCodexLike(agent: AgentType) {
    return getAgentCore(agent).permissions.modeGroup === 'codexLike';
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
            case 'read-only':
                return 'read-only';
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
            // Claude has no true read-only; fall back to the safest available mode.
            return 'default';
        case 'default':
            return 'default';
        default:
            return 'default';
    }
}
