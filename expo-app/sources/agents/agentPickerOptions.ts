import type { TranslationKey } from '@/text';
import type { AgentId } from './registryCore';
import { getAgentCore } from './registryCore';

export type AgentPickerOption = Readonly<{
    agentId: AgentId;
    titleKey: TranslationKey;
    subtitleKey: TranslationKey;
    iconName: string;
}>;

export function getAgentPickerOptions(agentIds: readonly AgentId[]): readonly AgentPickerOption[] {
    return agentIds.map((agentId) => {
        const core = getAgentCore(agentId);
        return {
            agentId,
            titleKey: core.displayNameKey,
            subtitleKey: core.subtitleKey,
            iconName: core.ui.agentPickerIconName,
        };
    });
}
