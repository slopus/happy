/**
 * Single integration entry point for the start-from-planning workflow.
 *
 * `applyAxOrchestration` is called once per outgoing user message in
 * `runClaude`. If the workspace is not an AX workspace (no `.ax/state.json`),
 * the function returns `null` and the caller takes the default upstream path.
 *
 * Otherwise it returns:
 *   - `userText`            — the original visible user message
 *   - `appendSystemPrompt`  — base.md plus L2 (step guide) and L3 (dynamic
 *                              context), merged with any user-supplied value
 *                              without accumulating stale AX blocks
 *
 * Corrupt/missing `state.json` degrades silently to `null` so the regular
 * Claude flow still works on workspaces that opt out of the AX workflow.
 */

import { readState } from '../state/io';
import { composeStepGuide, composeDynamicContext, loadBasePrompt } from './compose';
import type { AxStep } from '../state/schema';

const BASE_SENTINEL = '<!-- ax:base-prompt -->';
const TURN_CONTEXT_SENTINEL = '<!-- ax:turn-context -->';

export interface ApplyAxOrchestrationInput {
    workspaceRoot: string;
    userText: string;
    currentAppendSystemPrompt?: string;
}

export interface ApplyAxOrchestrationResult {
    userText: string;
    appendSystemPrompt: string;
    step: AxStep;
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

    const userText = input.userText;
    const appendSystemPrompt = mergeAxPrompt(input.currentAppendSystemPrompt, base, guide, context);

    return { userText, appendSystemPrompt, step: state.step };
}

function mergeAxPrompt(current: string | undefined, base: string, guide: string, context: string): string {
    const sentinelBlock = `${BASE_SENTINEL}\n${base.trimEnd()}\n${BASE_SENTINEL}`;
    const turnContextBlock = `${TURN_CONTEXT_SENTINEL}\n${guide.trimEnd()}\n\n${context.trimEnd()}\n${TURN_CONTEXT_SENTINEL}`;
    const withoutTurnContext = stripSentinelBlock(current, TURN_CONTEXT_SENTINEL);

    if (!withoutTurnContext || withoutTurnContext.length === 0) {
        return `${sentinelBlock}\n\n${turnContextBlock}`;
    }

    if (withoutTurnContext.includes(BASE_SENTINEL)) {
        return `${withoutTurnContext.trimEnd()}\n\n${turnContextBlock}`;
    }

    return `${sentinelBlock}\n\n${turnContextBlock}\n\n${withoutTurnContext}`;
}

function stripSentinelBlock(value: string | undefined, sentinel: string): string | undefined {
    if (!value) return value;
    const escaped = sentinel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return value.replace(new RegExp(`\\n*${escaped}\\n[\\s\\S]*?\\n${escaped}\\n*`, 'g'), '\n\n').trim();
}
