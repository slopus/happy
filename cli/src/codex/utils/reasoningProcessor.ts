/**
 * Codex Reasoning Processor
 *
 * Handles streaming reasoning deltas and identifies reasoning tools for Codex.
 * Extends BaseReasoningProcessor with Codex-specific configuration.
 */

import {
    BaseReasoningProcessor,
    ReasoningToolCall,
    ReasoningToolResult,
    ReasoningMessage,
    ReasoningOutput
} from '@/agent/BaseReasoningProcessor';

// Re-export types for backwards compatibility
export type { ReasoningToolCall, ReasoningToolResult, ReasoningMessage, ReasoningOutput };

/**
 * Codex-specific reasoning processor.
 */
export class ReasoningProcessor extends BaseReasoningProcessor {
    protected getToolName(): string {
        return 'CodexReasoning';
    }

    protected getLogPrefix(): string {
        return '[ReasoningProcessor]';
    }

    /**
     * Process a reasoning delta and accumulate content.
     */
    processDelta(delta: string): void {
        this.processInput(delta);
    }

    /**
     * Complete the reasoning section with final text.
     */
    complete(fullText: string): void {
        this.completeReasoning(fullText);
    }
}
