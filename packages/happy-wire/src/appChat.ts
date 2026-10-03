/** The application chat surface accepts model IDs, never arbitrary CLI options. */
export const appChatModels = {
    codex: ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna'],
    claude: ['sonnet', 'opus', 'haiku'],
} as const;
export type AppChatEngine = keyof typeof appChatModels;
export interface AppChatSelection { engine: AppChatEngine; model: string }
export const defaultAppChatSelection: AppChatSelection = { engine: 'codex', model: 'gpt-6-astra' };
export function parseAppChatSelection(value: unknown): AppChatSelection {
    if (value === undefined) return { ...defaultAppChatSelection };
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-model-selection');
    const selection = value as Record<string, unknown>;
    if (Object.keys(selection).some(key => !['engine', 'model'].includes(key)) ||
        !['codex', 'claude'].includes(String(selection.engine)) || typeof selection.model !== 'string' ||
        !(appChatModels[selection.engine as AppChatEngine] as readonly string[]).includes(selection.model)) throw new Error('invalid-model-selection');
    return { engine: selection.engine as AppChatEngine, model: selection.model };
}
