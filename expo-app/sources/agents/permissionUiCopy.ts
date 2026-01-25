import type { TranslationKey } from '@/text';
import { getAgentCore, type AgentId } from './registryCore';

export type PermissionFooterCopy =
    | Readonly<{
        protocol: 'codexDecision';
        yesAlwaysAllowCommandKey: TranslationKey;
        yesForSessionKey: TranslationKey;
        stopAndExplainKey: TranslationKey;
    }>
    | Readonly<{
        protocol: 'claude';
        yesAllowAllEditsKey: TranslationKey;
        yesForToolKey: TranslationKey;
        noTellAgentKey: TranslationKey;
    }>;

export function getPermissionFooterCopy(agentId: AgentId): PermissionFooterCopy {
    const protocol = getAgentCore(agentId).permissions.promptProtocol;
    if (protocol === 'codexDecision') {
        return {
            protocol,
            yesAlwaysAllowCommandKey: 'codex.permissions.yesAlwaysAllowCommand',
            yesForSessionKey: 'codex.permissions.yesForSession',
            stopAndExplainKey: 'codex.permissions.stopAndExplain',
        };
    }

    if (protocol === 'claude') {
        return {
            protocol: 'claude',
            yesAllowAllEditsKey: 'claude.permissions.yesAllowAllEdits',
            yesForToolKey: 'claude.permissions.yesForTool',
            noTellAgentKey: 'claude.permissions.noTellClaude',
        };
    }

    return {
        protocol: 'claude',
        yesAllowAllEditsKey: 'claude.permissions.yesAllowAllEdits',
        yesForToolKey: 'claude.permissions.yesForTool',
        noTellAgentKey: 'claude.permissions.noTellClaude',
    };
}
