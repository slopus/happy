import type { ModelMode } from './permissionTypes';
import { t } from '@/text';
import { getAgentCore, type AgentId } from '@/agents/catalog';

export type AgentType = AgentId;

export type ModelOption = Readonly<{
    value: ModelMode;
    label: string;
    description: string;
}>;

function getModelLabel(mode: ModelMode): string {
    switch (mode) {
        case 'gemini-2.5-pro':
            return t('agentInput.geminiModel.gemini25Pro.label');
        case 'gemini-2.5-flash':
            return t('agentInput.geminiModel.gemini25Flash.label');
        case 'gemini-2.5-flash-lite':
            return t('agentInput.geminiModel.gemini25FlashLite.label');
        default:
            return mode;
    }
}

function getModelDescription(mode: ModelMode): string {
    switch (mode) {
        case 'gemini-2.5-pro':
            return t('agentInput.geminiModel.gemini25Pro.description');
        case 'gemini-2.5-flash':
            return t('agentInput.geminiModel.gemini25Flash.description');
        case 'gemini-2.5-flash-lite':
            return t('agentInput.geminiModel.gemini25FlashLite.description');
        default:
            return '';
    }
}

export function getModelOptionsForModes(modes: readonly ModelMode[]): readonly ModelOption[] {
    return modes.map((mode) => ({
        value: mode,
        label: getModelLabel(mode),
        description: getModelDescription(mode),
    }));
}

export function getModelOptionsForAgentType(agentType: AgentType): readonly ModelOption[] {
    const core = getAgentCore(agentType);
    if (core.model.supportsSelection !== true) return [];
    return getModelOptionsForModes(core.model.allowedModes);
}
