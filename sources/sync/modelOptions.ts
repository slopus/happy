import type { ModelMode } from './permissionTypes';

export type AgentType = 'claude' | 'codex' | 'gemini';

export type ModelOption = Readonly<{
    value: ModelMode;
    label: string;
    description: string;
}>;

const GEMINI_MODEL_OPTIONS: readonly ModelOption[] = [
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', description: 'Most capable' },
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', description: 'Fast & efficient' },
    { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', description: 'Fastest' },
];

export function getModelOptionsForAgentType(agentType: AgentType): readonly ModelOption[] {
    if (agentType === 'gemini') return GEMINI_MODEL_OPTIONS;
    return [];
}
