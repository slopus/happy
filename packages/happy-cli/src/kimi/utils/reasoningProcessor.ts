/**
 * Kimi Reasoning Processor
 *
 * Handles streaming reasoning deltas and identifies reasoning sections for Kimi.
 * Extends BaseReasoningProcessor with Kimi-specific configuration.
 */

import {
    BaseReasoningProcessor,
    ReasoningToolCall,
    ReasoningToolResult,
    ReasoningMessage,
    ReasoningOutput
} from '@/utils/BaseReasoningProcessor';

// Re-export types for backwards compatibility
export type { ReasoningToolCall, ReasoningToolResult, ReasoningMessage, ReasoningOutput };

/**
 * Kimi-specific reasoning processor.
 */
export class KimiReasoningProcessor extends BaseReasoningProcessor {
    protected getToolName(): string {
        return 'KimiReasoning';
    }

    protected getLogPrefix(): string {
        return '[KimiReasoningProcessor]';
    }

    /**
     * Process a reasoning chunk from Kimi.
     * Kimi sends reasoning as chunks, we accumulate them.
     */
    processChunk(chunk: string): void {
        this.processInput(chunk);
    }

    /**
     * Complete the reasoning section.
     * Called when reasoning is complete (e.g., when status changes to idle).
     * Returns true if reasoning was actually completed, false if there was nothing to complete.
     */
    complete(): boolean {
        return this.completeReasoning();
    }
}
