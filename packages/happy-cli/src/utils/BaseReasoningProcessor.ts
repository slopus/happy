/**
 * Base Reasoning Processor
 *
 * Abstract base class for reasoning processors that handle streaming reasoning
 * deltas/chunks and identify reasoning sections with **[Title]** format.
 *
 * Shared by Codex and Gemini reasoning processors.
 *
 * @module BaseReasoningProcessor
 */

import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';

/**
 * Tool call for reasoning section with a title.
 */
export interface ReasoningToolCall {
    type: 'tool-call';
    name: string;  // 'CodexReasoning' or 'GeminiReasoning'
    callId: string;
    input: {
        title: string;
    };
    id: string;
}

/**
 * Result of a reasoning tool call.
 */
export interface ReasoningToolResult {
    type: 'tool-call-result';
    callId: string;
    output: {
        content?: string;
        status?: 'completed' | 'canceled';
    };
    id: string;
}

/**
 * Plain reasoning message without a title.
 */
export interface ReasoningMessage {
    type: 'reasoning';
    message: string;
    id: string;
}

export type ReasoningOutput = ReasoningToolCall | ReasoningToolResult | ReasoningMessage;

/**
 * Abstract base class for reasoning processors.
 *
 * Subclasses must implement:
 * - `getToolName()` - returns the tool name (e.g., 'CodexReasoning', 'GeminiReasoning')
 * - `getLogPrefix()` - returns the log prefix (e.g., '[ReasoningProcessor]')
 */
export abstract class BaseReasoningProcessor {
    protected accumulator: string = '';
    protected inTitleCapture: boolean = false;
    protected titleBuffer: string = '';
    protected contentBuffer: string = '';
    protected hasTitle: boolean = false;
    protected currentCallId: string | null = null;
    protected toolCallStarted: boolean = false;
    protected currentTitle: string | null = null;
    protected onMessage: ((message: any) => void) | null = null;

    /**
     * Returns the tool name for this processor.
     */
    protected abstract getToolName(): string;

    /**
     * Returns the log prefix for this processor.
     */
    protected abstract getLogPrefix(): string;

    constructor(onMessage?: (message: any) => void) {
        this.onMessage = onMessage || null;
        this.reset();
    }

    /**
     * Set the message callback for sending messages directly.
     */
    setMessageCallback(callback: (message: any) => void): void {
        this.onMessage = callback;
    }

    /**
     * Process a reasoning section break - indicates a new reasoning section is starting.
     */
    handleSectionBreak(): void {
        this.finishCurrentToolCall('canceled');
        this.resetState();
        logger.debug(`${this.getLogPrefix()} Section break - reset state`);
    }

    /**
     * Process a reasoning delta/chunk and accumulate content.
     */
    protected processInput(input: string): void {
        this.accumulator += input;

        // If we haven't started processing yet, check if this starts with **
        if (!this.inTitleCapture && !this.hasTitle && !this.contentBuffer) {
            if (this.accumulator.startsWith('**')) {
                // Start title capture
                this.inTitleCapture = true;
                this.titleBuffer = this.accumulator.substring(2); // Remove leading **
                logger.debug(`${this.getLogPrefix()} Started title capture`);
            } else if (this.accumulator.length > 0) {
                // This is untitled reasoning, just accumulate as content
                this.contentBuffer = this.accumulator;
            }
        } else if (this.inTitleCapture) {
            // We're capturing the title
            this.titleBuffer = this.accumulator.substring(2); // Keep updating from start

            // Check if we've found the closing **
            const titleEndIndex = this.titleBuffer.indexOf('**');
            if (titleEndIndex !== -1) {
                // Found the end of title
                const title = this.titleBuffer.substring(0, titleEndIndex);
                const afterTitle = this.titleBuffer.substring(titleEndIndex + 2);

                this.hasTitle = true;
                this.inTitleCapture = false;
                this.currentTitle = title;
                this.contentBuffer = afterTitle;

                // Generate a call ID for this reasoning section
                this.currentCallId = randomUUID();

                logger.debug(`${this.getLogPrefix()} Title captured: "${title}"`);

                // Send tool call immediately when title is detected
                this.sendToolCallStart(title);
            }
        } else if (this.hasTitle) {
            // We have a title, accumulate content after title
            const titleStartIndex = this.accumulator.indexOf('**');
            if (titleStartIndex !== -1) {
                this.contentBuffer = this.accumulator.substring(
                    titleStartIndex + 2 +
                    this.currentTitle!.length + 2
                );
            }
        } else {
            // Untitled reasoning, just accumulate
            this.contentBuffer = this.accumulator;
        }
    }

    /**
     * Send the tool call start message.
     */
    protected sendToolCallStart(title: string): void {
        if (!this.currentCallId || this.toolCallStarted) {
            return;
        }

        const toolCall: ReasoningToolCall = {
            type: 'tool-call',
            name: this.getToolName(),
            callId: this.currentCallId,
            input: {
                title: title
            },
            id: randomUUID()
        };

        logger.debug(`${this.getLogPrefix()} Sending tool call start for: "${title}"`);
        this.onMessage?.(toolCall);
        this.toolCallStarted = true;
    }

    /**
     * Complete the reasoning section.
     * Returns true if reasoning was completed, false if there was nothing to complete.
     */
    protected completeReasoning(fullText?: string): boolean {
        const text = fullText ?? this.accumulator;

        // If there's no content accumulated, don't send anything
        if (!text.trim() && !this.toolCallStarted) {
            logger.debug(`${this.getLogPrefix()} Complete called but no content accumulated, skipping`);
            return false;
        }

        // Extract title and content if present
        let title: string | undefined;
        let content: string = text;

        if (text.startsWith('**')) {
            const titleEndIndex = text.indexOf('**', 2);
            if (titleEndIndex !== -1) {
                title = text.substring(2, titleEndIndex);
                content = text.substring(titleEndIndex + 2).trim();
            }
        }

        logger.debug(`${this.getLogPrefix()} Complete reasoning - Title: "${title}", Has content: ${content.length > 0}`);

        if (title && !this.toolCallStarted) {
            // If we have a title but haven't sent the tool call yet, send it now
            this.currentCallId = this.currentCallId || randomUUID();
            this.sendToolCallStart(title);
        }

        if (this.toolCallStarted && this.currentCallId) {
            // Send tool call result for titled reasoning
            const toolResult: ReasoningToolResult = {
                type: 'tool-call-result',
                callId: this.currentCallId,
                output: {
                    content: content,
                    status: 'completed'
                },
                id: randomUUID()
            };
            logger.debug(`${this.getLogPrefix()} Sending tool call result`);
            this.onMessage?.(toolResult);
        } else if (content.trim()) {
            // Send regular reasoning message for untitled reasoning (only if there's content)
            const reasoningMessage: ReasoningMessage = {
                type: 'reasoning',
                message: content,
                id: randomUUID()
            };
            logger.debug(`${this.getLogPrefix()} Sending reasoning message`);
            this.onMessage?.(reasoningMessage);
        }

        // Reset state after completion
        this.resetState();
        return true;
    }

    /**
     * Abort the current reasoning section.
     */
    abort(): void {
        logger.debug(`${this.getLogPrefix()} Abort called`);
        this.finishCurrentToolCall('canceled');
        this.resetState();
    }

    /**
     * Reset the processor state.
     */
    reset(): void {
        this.finishCurrentToolCall('canceled');
        this.resetState();
    }

    /**
     * Finish current tool call if one is in progress.
     */
    protected finishCurrentToolCall(status: 'completed' | 'canceled'): void {
        if (this.toolCallStarted && this.currentCallId) {
            // Send tool call result with canceled status
            const toolResult: ReasoningToolResult = {
                type: 'tool-call-result',
                callId: this.currentCallId,
                output: {
                    content: this.contentBuffer || '',
                    status: status
                },
                id: randomUUID()
            };
            logger.debug(`${this.getLogPrefix()} Sending tool call result with status: ${status}`);
            this.onMessage?.(toolResult);
        }
    }

    /**
     * Reset internal state.
     */
    protected resetState(): void {
        this.accumulator = '';
        this.inTitleCapture = false;
        this.titleBuffer = '';
        this.contentBuffer = '';
        this.hasTitle = false;
        this.currentCallId = null;
        this.toolCallStarted = false;
        this.currentTitle = null;
    }

    /**
     * Get the current call ID for tool result matching.
     */
    getCurrentCallId(): string | null {
        return this.currentCallId;
    }

    /**
     * Check if a tool call has been started.
     */
    hasStartedToolCall(): boolean {
        return this.toolCallStarted;
    }
}
