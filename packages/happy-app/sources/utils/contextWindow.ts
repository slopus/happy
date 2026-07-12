// Context-window sizing for the input-bar usage indicator.
//
// Anthropic exposes a 1M-token context window on some models, surfaced in
// Happy's model picker as a `[1m]` suffix on the selected model key
// (e.g. `claude-opus-4-8[1m]`). The API response echoes only the base model id
// (`claude-opus-4-8`), so the window must be sized from the selected model key.
// The indicator used to assume a fixed 190K window, so on 1M models it clamped
// to ~73% remaining on a fresh session and dropped fast (#910).

export const DEFAULT_MAX_CONTEXT_SIZE = 190000;
export const ONE_MILLION_CONTEXT_SIZE = 1000000;

export function maxContextSizeForModel(model?: string): number {
    if (model && model.includes('[1m]')) {
        return ONE_MILLION_CONTEXT_SIZE;
    }
    return DEFAULT_MAX_CONTEXT_SIZE;
}
