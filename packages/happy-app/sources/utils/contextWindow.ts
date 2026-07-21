// Context-window sizing for the input-bar usage indicator.
//
// The Agent SDK never reports the real context window for a session (the usage
// block carries token counts only, not a window size — see reducer.ts), so the
// window must be inferred from the selected model key. The indicator used to
// assume a fixed 190K window, so on 1M-token models it clamped to ~100% used on
// a fresh session and pinned the gauge to "none left" (#910).
//
// Which models run the 1M window, per Claude Code's model-config:
//   - Fable 5 / Mythos: 1M is the ONLY window (the max is also the default) —
//     there is no 200K variant and no `[1m]` suffix to select.
//   - Opus 4.8 / Opus 4.7 / Sonnet 5: always run 1M on the Anthropic API. The
//     bare `opus`/`sonnet` picker aliases resolve to the latest of each
//     (Opus 4.8 / Sonnet 5), so they are 1M too.
//   - Older versions (Opus 4.6, Sonnet 4.6) and LLM-gateway deployments default
//     to 200K and must carry the `[1m]` suffix to signal the 1M window — those
//     fall through to the 190K default below.
//   - Haiku is 200K-capped; unknown/`default` keys stay conservative at 190K.

export const DEFAULT_MAX_CONTEXT_SIZE = 190000;
export const ONE_MILLION_CONTEXT_SIZE = 1000000;

// Model families/versions whose context window is 1M by default on the Anthropic
// API, with no `[1m]` opt-in required. Matched as substrings of the model key so
// both the raw ids (`claude-fable-5`, `claude-opus-4-8`) and any suffixed variant
// resolve correctly. Opus 4.6 / Sonnet 4.6 are deliberately absent — they need
// the `[1m]` suffix.
const ALWAYS_ONE_MILLION_PATTERNS = ['fable', 'mythos', 'opus-4-8', 'opus-4-7', 'sonnet-5'];

export function maxContextSizeForModel(model?: string): number {
    if (!model) {
        return DEFAULT_MAX_CONTEXT_SIZE;
    }
    const key = model.toLowerCase();

    // Explicit 1M opt-in suffix (older versions + gateway deployments).
    if (key.includes('[1m]')) {
        return ONE_MILLION_CONTEXT_SIZE;
    }
    // Bare picker aliases resolve to the latest model of the tier, which runs 1M.
    if (key === 'opus' || key === 'sonnet') {
        return ONE_MILLION_CONTEXT_SIZE;
    }
    // Model families/versions that always run the 1M window on the Anthropic API.
    if (ALWAYS_ONE_MILLION_PATTERNS.some((pattern) => key.includes(pattern))) {
        return ONE_MILLION_CONTEXT_SIZE;
    }
    return DEFAULT_MAX_CONTEXT_SIZE;
}
