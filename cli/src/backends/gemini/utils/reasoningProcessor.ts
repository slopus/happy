/**
 * Gemini Reasoning Processor
 *
 * Handles agent_thought_chunk events for Gemini ACP.
 * Extends BaseReasoningProcessor with Gemini-specific configuration.
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
 * Gemini-specific reasoning processor.
 */
export class GeminiReasoningProcessor extends BaseReasoningProcessor {
    protected getToolName(): string {
        return 'GeminiReasoning';
    }

    protected getLogPrefix(): string {
        return '[GeminiReasoningProcessor]';
    }

    /**
     * Process a reasoning chunk from agent_thought_chunk.
     * Gemini sends reasoning as chunks, we accumulate them similar to Codex.
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
