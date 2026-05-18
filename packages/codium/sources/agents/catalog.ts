export type AgentEngine = 'codex' | 'claude'

export interface AgentModel {
    id: string
    engine: AgentEngine
    label: string
    group: string
    model?: string
    description?: string
}

export const AGENT_MODELS: AgentModel[] = [
    {
        id: 'codex-default',
        engine: 'codex',
        label: 'Codex',
        group: 'OpenAI',
        description: 'Bundled Codex CLI default model.',
    },
    {
        id: 'claude-default',
        engine: 'claude',
        label: 'Claude',
        group: 'Anthropic',
        description: 'Bundled Claude Agent SDK default model.',
    },
    {
        id: 'claude-sonnet',
        engine: 'claude',
        label: 'Sonnet',
        group: 'Anthropic',
        model: 'sonnet',
    },
    {
        id: 'claude-opus',
        engine: 'claude',
        label: 'Opus',
        group: 'Anthropic',
        model: 'opus',
    },
]

export function agentModelById(id: string): AgentModel {
    return AGENT_MODELS.find((model) => model.id === id) ?? AGENT_MODELS[0]
}
