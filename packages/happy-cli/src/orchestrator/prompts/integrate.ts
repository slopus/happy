/**
 * Single integration entry point for the start-from-planning workflow.
 *
 * `applyAxOrchestration` is called once per outgoing user message in
 * `runClaude`. If the workspace is not an AX workspace (no `.ax/state.json`),
 * the function returns `null` and the caller takes the default upstream path.
 *
 * Otherwise it returns:
 *   - `userText`            — the original message with L2 (step guide) and
 *                              L3 (dynamic context) prepended
 *   - `appendSystemPrompt`  — base.md merged with any user-supplied value,
 *                              idempotent so repeated turns don't bloat
 *
 * Corrupt/missing `state.json` degrades silently to `null` so the regular
 * Claude flow still works on workspaces that opt out of the AX workflow.
 */

import { readState } from '../state/io';
import { composeStepGuide, composeDynamicContext, loadBasePrompt } from './compose';

const BASE_SENTINEL = '<!-- ax:base-prompt -->';

export interface ApplyAxOrchestrationInput {
    workspaceRoot: string;
    userText: string;
    currentAppendSystemPrompt?: string;
}

export interface ApplyAxOrchestrationResult {
    userText: string;
    appendSystemPrompt: string;
}

export async function applyAxOrchestration(
    input: ApplyAxOrchestrationInput,
): Promise<ApplyAxOrchestrationResult | null> {
    let state;
    try {
        state = await readState(input.workspaceRoot);
    } catch {
        // No state, corrupt state, or read error — opt out gracefully.
        return null;
    }

    const [guide, context, base] = await Promise.all([
        composeStepGuide(state.step),
        composeDynamicContext(input.workspaceRoot, state),
        loadBasePrompt(),
    ]);

    const userText = [guide.trimEnd(), '', context.trimEnd(), '', input.userText].join('\n');
    const appendSystemPrompt = mergeBasePrompt(input.currentAppendSystemPrompt, base);

    return { userText, appendSystemPrompt };
}

function mergeBasePrompt(current: string | undefined, base: string): string {
    const sentinelBlock = `${BASE_SENTINEL}\n${base.trimEnd()}\n${BASE_SENTINEL}`;
    if (!current || current.length === 0) return sentinelBlock;
    if (current.includes(BASE_SENTINEL)) return current;
    return `${sentinelBlock}\n\n${current}`;
}
