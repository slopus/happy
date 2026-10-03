import type { MessageMeta, PermissionMode } from '@/api/types';
import { CHANGE_TITLE_INSTRUCTION } from '@/gemini/constants';
import {
    isSaycodePromptBlockEnabled,
    type SaycodePromptBlockOverrides,
} from '@/prompt/promptProvenance';
import { hashObject } from '@/utils/deterministicJson';
import { SAYCODE_API_GATEWAY_PROMPT } from '@/prompt/saycodeApiGatewayPrompt';

import type { ReasoningEffort } from './codexAppServerTypes';

export interface CodexEnhancedMode {
    permissionMode: PermissionMode;
    model?: string;
    /** Happy app instructions appended to the first Codex prompt for option chips. */
    appendSystemPrompt?: string;
    /** Explicit policy for Saycode-owned instructions. Missing preserves legacy enabled behavior. */
    saycodeSystemPromptEnabled?: boolean;
    /** Per-block overrides; default-on blocks do not inherit the master policy. */
    saycodePromptBlocks?: SaycodePromptBlockOverrides;
    /** Reasoning effort passed through to Codex's sendTurnAndWait. */
    effort?: ReasoningEffort;
}

// Keep this identifier and array form stable: Desktop's staged-runtime guard also
// recognizes it in the bundled CLI while older Happy releases still need patching.
const VALID_REMOTE_EFFORTS: readonly ReasoningEffort[] = [
    'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
];

export function isSupportedCodexReasoningEffort(value: unknown): value is ReasoningEffort {
    return typeof value === 'string' && VALID_REMOTE_EFFORTS.includes(value as ReasoningEffort);
}

export function resolveCodexSaycodePromptBlocks(
    current: CodexEnhancedMode['saycodePromptBlocks'],
    meta: Pick<MessageMeta, 'saycodePromptBlocks'> | undefined,
): CodexEnhancedMode['saycodePromptBlocks'] {
    if (!Object.prototype.hasOwnProperty.call(meta ?? {}, 'saycodePromptBlocks')) {
        return current;
    }

    return meta?.saycodePromptBlocks ?? undefined;
}

export function hashCodexEnhancedMode(mode: CodexEnhancedMode): string {
    return hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model,
        appendSystemPrompt: mode.appendSystemPrompt,
        saycodeSystemPromptEnabled: mode.saycodeSystemPromptEnabled,
        saycodePromptBlocks: mode.saycodePromptBlocks,
        effort: mode.effort,
    });
}

export function buildCodexDeveloperInstructions({
    connectorGuidance,
    checkpointGuidance,
    agentOrchestrationPrompt,
    mode,
}: {
    connectorGuidance?: string;
    checkpointGuidance?: string;
    agentOrchestrationPrompt?: string;
    mode: Pick<CodexEnhancedMode, 'appendSystemPrompt' | 'saycodeSystemPromptEnabled' | 'saycodePromptBlocks'>;
}): string | undefined {
    const blocks = [connectorGuidance, checkpointGuidance];
    if (isSaycodePromptBlockEnabled(
        'agentOrchestration',
        mode.saycodePromptBlocks,
        mode.saycodeSystemPromptEnabled,
    )) {
        blocks.push(agentOrchestrationPrompt);
    }
    if (mode.saycodeSystemPromptEnabled !== undefined) {
        blocks.push(mode.appendSystemPrompt);
    }
    if (mode.saycodeSystemPromptEnabled !== false) {
        blocks.push(SAYCODE_API_GATEWAY_PROMPT);
    }
    return blocks.filter((block): block is string => Boolean(block)).join('\n\n') || undefined;
}

export function buildCodexTurnPrompt(opts: {
    message: string;
    mode: Pick<CodexEnhancedMode, 'appendSystemPrompt' | 'saycodeSystemPromptEnabled'>;
    includeAppendSystemPrompt: boolean;
    hasTitle: boolean;
    /**
     * Project lessons recalled for this turn, already bounded and labelled.
     *
     * Placed before the user's message and after the system prompt: it is
     * reference material for the request that follows, not an instruction of
     * its own, and the block says so in its own words.
     */
    lessonBlock?: string;
}): string {
    const parts: string[] = [];

    if (opts.includeAppendSystemPrompt && opts.mode.appendSystemPrompt) {
        parts.push(opts.mode.appendSystemPrompt);
    }
    if (opts.lessonBlock) {
        parts.push(opts.lessonBlock);
    }
    parts.push(opts.message);

    if (!opts.hasTitle) {
        parts.push(CHANGE_TITLE_INSTRUCTION);
    }

    return parts.join('\n\n');
}
