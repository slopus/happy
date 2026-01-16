import type { ModelMode } from './permissionTypes';
import { t } from '@/text';

export type AgentType = 'claude' | 'codex' | 'gemini';

export type ModelOption = Readonly<{
    value: ModelMode;
    label: string;
    description: string;
}>;

export function getModelOptionsForAgentType(agentType: AgentType): readonly ModelOption[] {
    if (agentType === 'gemini') {
        return [
            {
                value: 'gemini-2.5-pro',
                label: t('agentInput.geminiModel.gemini25Pro.label'),
                description: t('agentInput.geminiModel.gemini25Pro.description'),
            },
            {
                value: 'gemini-2.5-flash',
                label: t('agentInput.geminiModel.gemini25Flash.label'),
                description: t('agentInput.geminiModel.gemini25Flash.description'),
            },
            {
                value: 'gemini-2.5-flash-lite',
                label: t('agentInput.geminiModel.gemini25FlashLite.label'),
                description: t('agentInput.geminiModel.gemini25FlashLite.description'),
            },
        ];
    }
    return [];
}
