export type AgentFlavor = 'claude' | 'codex' | 'gemini';

export const MODEL_MODE_DEFAULT = 'default' as const;

export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type CodexModelFamily =
    | typeof MODEL_MODE_DEFAULT
    | 'gpt-5.4'
    | 'gpt-5.3-codex'
    | 'gpt-5.2-codex'
    | 'gpt-5.2'
    | 'gpt-5.1-codex-max'
    | 'gpt-5.1-codex-mini';

export const MODEL_MODES = [
    MODEL_MODE_DEFAULT,
    'claude-opus-4-6',
    'claude-opus-4-5',
    'claude-sonnet-4-6',
    'claude-sonnet-4-5',
    'claude-haiku-4-5',
    'gpt-5.4-low',
    'gpt-5.4-medium',
    'gpt-5.4-high',
    'gpt-5.4-xhigh',
    'gpt-5.3-codex-low',
    'gpt-5.3-codex-medium',
    'gpt-5.3-codex-high',
    'gpt-5.3-codex-xhigh',
    'gpt-5.2-codex-low',
    'gpt-5.2-codex-medium',
    'gpt-5.2-codex-high',
    'gpt-5.2-codex-xhigh',
    'gpt-5.2-low',
    'gpt-5.2-medium',
    'gpt-5.2-high',
    'gpt-5.2-xhigh',
    'gpt-5.1-codex-max-low',
    'gpt-5.1-codex-max-medium',
    'gpt-5.1-codex-max-high',
    'gpt-5.1-codex-max-xhigh',
    'gpt-5.1-codex-mini-medium',
    'gpt-5.1-codex-mini-high',
    'gemini-3-pro-preview',
    'gemini-3-flash-preview',
    'gemini-2.5-pro',
] as const;

export type ModelMode = typeof MODEL_MODES[number];

export const CLAUDE_MODEL_MODES = [
    MODEL_MODE_DEFAULT,
    'claude-opus-4-6',
    'claude-opus-4-5',
    'claude-sonnet-4-6',
    'claude-sonnet-4-5',
    'claude-haiku-4-5',
] as const satisfies readonly ModelMode[];

export const GEMINI_MODEL_MODES = [
    MODEL_MODE_DEFAULT,
    'gemini-3-pro-preview',
    'gemini-3-flash-preview',
    'gemini-2.5-pro',
] as const satisfies readonly ModelMode[];

export const CODEX_MODEL_MODES = [
    MODEL_MODE_DEFAULT,
    'gpt-5.4-low',
    'gpt-5.4-medium',
    'gpt-5.4-high',
    'gpt-5.4-xhigh',
    'gpt-5.3-codex-low',
    'gpt-5.3-codex-medium',
    'gpt-5.3-codex-high',
    'gpt-5.3-codex-xhigh',
    'gpt-5.2-codex-low',
    'gpt-5.2-codex-medium',
    'gpt-5.2-codex-high',
    'gpt-5.2-codex-xhigh',
    'gpt-5.2-low',
    'gpt-5.2-medium',
    'gpt-5.2-high',
    'gpt-5.2-xhigh',
    'gpt-5.1-codex-max-low',
    'gpt-5.1-codex-max-medium',
    'gpt-5.1-codex-max-high',
    'gpt-5.1-codex-max-xhigh',
    'gpt-5.1-codex-mini-medium',
    'gpt-5.1-codex-mini-high',
] as const satisfies readonly ModelMode[];

const MODEL_MODE_SET = new Set<ModelMode>(MODEL_MODES);
const CLAUDE_MODEL_MODE_SET = new Set<ModelMode>(CLAUDE_MODEL_MODES);
const GEMINI_MODEL_MODE_SET = new Set<ModelMode>(GEMINI_MODEL_MODES);
const CODEX_MODEL_MODE_SET = new Set<ModelMode>(CODEX_MODEL_MODES);

export function isModelMode(value: string): value is ModelMode {
    return MODEL_MODE_SET.has(value as ModelMode);
}

export function isModelModeForAgent(agent: AgentFlavor, mode: string): mode is ModelMode {
    if (!isModelMode(mode)) return false;
    if (agent === 'claude') return CLAUDE_MODEL_MODE_SET.has(mode);
    if (agent === 'gemini') return GEMINI_MODEL_MODE_SET.has(mode);
    return CODEX_MODEL_MODE_SET.has(mode);
}

export function getValidModelModesForAgent(agent: AgentFlavor): readonly ModelMode[] {
    if (agent === 'claude') return CLAUDE_MODEL_MODES;
    if (agent === 'gemini') return GEMINI_MODEL_MODES;
    return CODEX_MODEL_MODES;
}

export const CLAUDE_MODEL_OPTIONS = [
    { value: MODEL_MODE_DEFAULT, label: 'Use CLI configured model', shortLabel: 'CLI', description: 'Use profile/CLI defaults' },
    { value: 'claude-opus-4-6', label: 'Claude Opus 4.6', shortLabel: 'Opus 4.6', description: 'Most capable' },
    { value: 'claude-opus-4-5', label: 'Claude Opus 4.5', shortLabel: 'Opus 4.5', description: 'Most capable' },
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', shortLabel: 'Sonnet 4.6', description: 'Balanced speed and quality' },
    { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', shortLabel: 'Sonnet 4.5', description: 'Balanced speed and quality' },
    { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', shortLabel: 'Haiku 4.5', description: 'Fastest' },
] as const;

export const GEMINI_MODEL_OPTIONS = [
    { value: MODEL_MODE_DEFAULT, label: 'Use CLI configured model', shortLabel: 'CLI', description: 'Use profile/CLI defaults' },
    { value: 'gemini-3-pro-preview', label: 'Gemini 3 Pro (Preview)', shortLabel: '3 Pro', description: 'Most capable' },
    { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash (Preview)', shortLabel: '3 Flash', description: 'Fast and efficient' },
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', shortLabel: '2.5 Pro', description: 'Most capable' },
] as const;

export const CODEX_MODEL_FAMILY_OPTIONS = [
    { value: MODEL_MODE_DEFAULT, label: 'Use CLI configured model', shortLabel: 'CLI', description: 'Use profile/CLI defaults' },
    { value: 'gpt-5.4', label: 'GPT-5.4', shortLabel: '5.4', description: 'General-purpose model' },
    { value: 'gpt-5.3-codex', label: 'GPT-5.3-Codex', shortLabel: '5.3-Codex', description: 'Code-optimized model' },
    { value: 'gpt-5.2-codex', label: 'GPT-5.2-Codex', shortLabel: '5.2-Codex', description: 'Code-optimized model' },
    { value: 'gpt-5.2', label: 'GPT-5.2', shortLabel: '5.2', description: 'General-purpose model' },
    { value: 'gpt-5.1-codex-max', label: 'GPT-5.1-Codex-Max', shortLabel: '5.1-Max', description: 'Code-optimized model' },
    { value: 'gpt-5.1-codex-mini', label: 'GPT-5.1-Codex-Mini', shortLabel: '5.1-Mini', description: 'Fast code-focused model' },
] as const satisfies readonly { value: CodexModelFamily; label: string; shortLabel: string; description: string }[];

export const CODEX_MODEL_OPTIONS = [
    { value: MODEL_MODE_DEFAULT, label: 'Default', description: 'Use CLI default model' },
    { value: 'gpt-5.4-low', label: 'GPT-5.4 (Low)', description: 'Fast responses' },
    { value: 'gpt-5.4-medium', label: 'GPT-5.4 (Medium)', description: 'Balanced responses' },
    { value: 'gpt-5.4-high', label: 'GPT-5.4 (High)', description: 'Strong quality' },
    { value: 'gpt-5.4-xhigh', label: 'GPT-5.4 (XHigh)', description: 'Best quality' },
    { value: 'gpt-5.3-codex-low', label: 'GPT-5.3-Codex (Low)', description: 'Fastest coding responses' },
    { value: 'gpt-5.3-codex-medium', label: 'GPT-5.3-Codex (Medium)', description: 'Balanced coding quality' },
    { value: 'gpt-5.3-codex-high', label: 'GPT-5.3-Codex (High)', description: 'Strong coding quality' },
    { value: 'gpt-5.3-codex-xhigh', label: 'GPT-5.3-Codex (XHigh)', description: 'Best coding quality' },
    { value: 'gpt-5.2-codex-low', label: 'GPT-5.2-Codex (Low)', description: 'Fast coding responses' },
    { value: 'gpt-5.2-codex-medium', label: 'GPT-5.2-Codex (Medium)', description: 'Balanced coding quality' },
    { value: 'gpt-5.2-codex-high', label: 'GPT-5.2-Codex (High)', description: 'Strong coding quality' },
    { value: 'gpt-5.2-codex-xhigh', label: 'GPT-5.2-Codex (XHigh)', description: 'Best coding quality' },
    { value: 'gpt-5.2-low', label: 'GPT-5.2 (Low)', description: 'Fast responses' },
    { value: 'gpt-5.2-medium', label: 'GPT-5.2 (Medium)', description: 'Balanced responses' },
    { value: 'gpt-5.2-high', label: 'GPT-5.2 (High)', description: 'Strong quality' },
    { value: 'gpt-5.2-xhigh', label: 'GPT-5.2 (XHigh)', description: 'Best quality' },
    { value: 'gpt-5.1-codex-max-low', label: 'GPT-5.1-Codex-Max (Low)', description: 'Fast responses' },
    { value: 'gpt-5.1-codex-max-medium', label: 'GPT-5.1-Codex-Max (Medium)', description: 'Balanced responses' },
    { value: 'gpt-5.1-codex-max-high', label: 'GPT-5.1-Codex-Max (High)', description: 'Strong quality' },
    { value: 'gpt-5.1-codex-max-xhigh', label: 'GPT-5.1-Codex-Max (XHigh)', description: 'Best quality' },
    { value: 'gpt-5.1-codex-mini-medium', label: 'GPT-5.1-Codex-Mini (Medium)', description: 'Balanced speed and quality' },
    { value: 'gpt-5.1-codex-mini-high', label: 'GPT-5.1-Codex-Mini (High)', description: 'Higher quality with good speed' },
] as const satisfies readonly { value: ModelMode; label: string; description: string }[];

const CODEX_MODE_TO_SELECTION: Partial<Record<ModelMode, { family: CodexModelFamily; effort: CodexReasoningEffort }>> = {
    'gpt-5.4-low': { family: 'gpt-5.4', effort: 'low' },
    'gpt-5.4-medium': { family: 'gpt-5.4', effort: 'medium' },
    'gpt-5.4-high': { family: 'gpt-5.4', effort: 'high' },
    'gpt-5.4-xhigh': { family: 'gpt-5.4', effort: 'xhigh' },
    'gpt-5.3-codex-low': { family: 'gpt-5.3-codex', effort: 'low' },
    'gpt-5.3-codex-medium': { family: 'gpt-5.3-codex', effort: 'medium' },
    'gpt-5.3-codex-high': { family: 'gpt-5.3-codex', effort: 'high' },
    'gpt-5.3-codex-xhigh': { family: 'gpt-5.3-codex', effort: 'xhigh' },
    'gpt-5.2-codex-low': { family: 'gpt-5.2-codex', effort: 'low' },
    'gpt-5.2-codex-medium': { family: 'gpt-5.2-codex', effort: 'medium' },
    'gpt-5.2-codex-high': { family: 'gpt-5.2-codex', effort: 'high' },
    'gpt-5.2-codex-xhigh': { family: 'gpt-5.2-codex', effort: 'xhigh' },
    'gpt-5.2-low': { family: 'gpt-5.2', effort: 'low' },
    'gpt-5.2-medium': { family: 'gpt-5.2', effort: 'medium' },
    'gpt-5.2-high': { family: 'gpt-5.2', effort: 'high' },
    'gpt-5.2-xhigh': { family: 'gpt-5.2', effort: 'xhigh' },
    'gpt-5.1-codex-max-low': { family: 'gpt-5.1-codex-max', effort: 'low' },
    'gpt-5.1-codex-max-medium': { family: 'gpt-5.1-codex-max', effort: 'medium' },
    'gpt-5.1-codex-max-high': { family: 'gpt-5.1-codex-max', effort: 'high' },
    'gpt-5.1-codex-max-xhigh': { family: 'gpt-5.1-codex-max', effort: 'xhigh' },
    'gpt-5.1-codex-mini-medium': { family: 'gpt-5.1-codex-mini', effort: 'medium' },
    'gpt-5.1-codex-mini-high': { family: 'gpt-5.1-codex-mini', effort: 'high' },
};

export function parseCodexModelMode(mode: ModelMode): { family: CodexModelFamily; effort: CodexReasoningEffort } {
    return CODEX_MODE_TO_SELECTION[mode] ?? { family: MODEL_MODE_DEFAULT, effort: 'medium' };
}

export function getCodexReasoningOptions(family: CodexModelFamily): readonly CodexReasoningEffort[] {
    if (family === 'gpt-5.1-codex-mini') return ['high', 'medium'];
    if (family === MODEL_MODE_DEFAULT) return ['high', 'medium', 'low'];
    return ['xhigh', 'high', 'medium', 'low'];
}

export function buildCodexModelMode(
    family: CodexModelFamily,
    effort: CodexReasoningEffort,
): ModelMode {
    if (family === MODEL_MODE_DEFAULT) return MODEL_MODE_DEFAULT;
    if (family === 'gpt-5.1-codex-mini') {
        const miniEffort = effort === 'high' ? 'high' : 'medium';
        return `gpt-5.1-codex-mini-${miniEffort}` as ModelMode;
    }
    return `${family}-${effort}` as ModelMode;
}

export type ModelSelection = {
    model: string | null;
    reasoningEffort: CodexReasoningEffort | null;
};

const MODEL_NAME_LABELS: Record<string, string> = {
    'gpt-5.4': 'GPT-5.4',
    'gpt-5.3-codex': 'GPT-5.3-Codex',
    'gpt-5.2-codex': 'GPT-5.2-Codex',
    'gpt-5.2': 'GPT-5.2',
    'gpt-5.1-codex-max': 'GPT-5.1-Codex-Max',
    'gpt-5.1-codex-mini': 'GPT-5.1-Codex-Mini',
    'claude-opus-4-6': 'Claude Opus 4.6',
    'claude-opus-4-5': 'Claude Opus 4.5',
    'claude-sonnet-4-6': 'Claude Sonnet 4.6',
    'claude-sonnet-4-5': 'Claude Sonnet 4.5',
    'claude-haiku-4-5': 'Claude Haiku 4.5',
    'gemini-3-pro-preview': 'Gemini 3 Pro (Preview)',
    'gemini-3-flash-preview': 'Gemini 3 Flash (Preview)',
    'gemini-2.5-pro': 'Gemini 2.5 Pro',
};

const REASONING_EFFORT_LABELS: Record<string, string> = {
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'XHigh',
};

export function resolveModelSelectionForFlavor(flavor: string | null | undefined, modelMode: string): ModelSelection {
    if (modelMode === MODEL_MODE_DEFAULT) return { model: null, reasoningEffort: null };
    if (!isModelMode(modelMode)) return { model: modelMode, reasoningEffort: null };
    if (flavor === 'codex') {
        const parsed = parseCodexModelMode(modelMode);
        if (parsed.family === MODEL_MODE_DEFAULT) return { model: modelMode, reasoningEffort: null };
        return { model: parsed.family, reasoningEffort: parsed.effort };
    }
    if (flavor === 'claude' || flavor === 'gemini') return { model: modelMode, reasoningEffort: null };
    return { model: null, reasoningEffort: null };
}

export function resolveLocalModelDisplay(modelMode: string | null | undefined): ModelSelection {
    if (!modelMode || modelMode === MODEL_MODE_DEFAULT) return { model: null, reasoningEffort: null };
    if (!isModelMode(modelMode)) return { model: modelMode, reasoningEffort: null };

    const parsedCodex = parseCodexModelMode(modelMode);
    if (parsedCodex.family !== MODEL_MODE_DEFAULT) {
        return { model: parsedCodex.family, reasoningEffort: parsedCodex.effort };
    }

    return { model: modelMode, reasoningEffort: null };
}

export function formatModelNameLabel(model: string | null | undefined): string | null {
    if (!model) return null;
    if (MODEL_NAME_LABELS[model]) return MODEL_NAME_LABELS[model];
    if (isModelMode(model)) {
        const codexParsed = parseCodexModelMode(model);
        if (codexParsed.family !== MODEL_MODE_DEFAULT) {
            return MODEL_NAME_LABELS[codexParsed.family] ?? codexParsed.family;
        }
    }
    // Strip date suffix: YYYYMMDD (Claude) or YYYY-MM-DD (OpenAI/Codex)
    const stripped = model.replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
    if (stripped !== model && MODEL_NAME_LABELS[stripped]) return MODEL_NAME_LABELS[stripped];
    return model;
}

export function formatReasoningEffortLabel(effort: string | null | undefined): string | null {
    if (!effort) return null;
    return REASONING_EFFORT_LABELS[effort] ?? effort;
}

export function formatModelDisplay(model: string | null | undefined, reasoningEffort: string | null | undefined): string | null {
    const modelLabel = formatModelNameLabel(model);
    if (!modelLabel) return null;
    const effortLabel = formatReasoningEffortLabel(reasoningEffort);
    return effortLabel ? `${modelLabel} (${effortLabel})` : modelLabel;
}

// ─── Context Window Sizes ──────────────────────────────────────

const DEFAULT_CONTEXT_WINDOW = 200_000;

const AGENT_DEFAULT_CONTEXT_WINDOWS: Record<AgentFlavor, number> = {
    claude: 200_000,
    codex: 258_400,
    gemini: 1_000_000,
};

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
    // Claude models
    'claude-opus-4-6': 200_000,
    'claude-opus-4-5': 200_000,
    'claude-sonnet-4-6': 200_000,
    'claude-sonnet-4-5': 200_000,
    'claude-haiku-4-5': 200_000,
    // Codex models (fallback; actual value comes from CLI via context_window_size)
    'gpt-5.4': 258_400,
    'gpt-5.3-codex': 258_400,
    'gpt-5.2-codex': 258_400,
    'gpt-5.2': 258_400,
    'gpt-5.1-codex-max': 258_400,
    'gpt-5.1-codex-mini': 258_400,
    // Gemini models
    'gemini-3-pro-preview': 1_000_000,
    'gemini-3-flash-preview': 1_000_000,
    'gemini-2.5-pro': 1_000_000,
};

/**
 * Get the max context window size for a given model mode and agent flavor.
 * Falls back to agent default, then global default.
 */
export function getMaxContextSize(modelMode: string | null | undefined, agentFlavor: AgentFlavor | string | null | undefined): number {
    // Try exact model mode match (for composite codex modes, extract family)
    if (modelMode && modelMode !== MODEL_MODE_DEFAULT) {
        if (MODEL_CONTEXT_WINDOWS[modelMode]) return MODEL_CONTEXT_WINDOWS[modelMode];
        // For codex composite modes like "gpt-5.3-codex-high", extract family
        if (isModelMode(modelMode)) {
            const parsed = parseCodexModelMode(modelMode);
            if (parsed.family !== MODEL_MODE_DEFAULT && MODEL_CONTEXT_WINDOWS[parsed.family]) {
                return MODEL_CONTEXT_WINDOWS[parsed.family];
            }
        }
    }
    // Fall back to agent default
    if (agentFlavor && agentFlavor in AGENT_DEFAULT_CONTEXT_WINDOWS) {
        return AGENT_DEFAULT_CONTEXT_WINDOWS[agentFlavor as AgentFlavor];
    }
    return DEFAULT_CONTEXT_WINDOW;
}
