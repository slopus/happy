/**
 * Reasoning Processor for Gemini - Handles agent_thought_chunk events
 * 
 * This processor accumulates agent_thought_chunk events from Gemini ACP
 * and identifies when reasoning sections start with **[Title]** format,
 * treating them as tool calls (similar to Codex's ReasoningProcessor).
 */

import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';

export interface ReasoningToolCall {
    type: 'tool-call';
    name: 'GeminiReasoning';
    callId: string;
    input: {
        title: string;
    };
    id: string;
}

export interface ReasoningToolResult {
    type: 'tool-call-result';
    callId: string;
    output: {
        content?: string;
        status?: 'completed' | 'canceled';
    };
    id: string;
}

export interface ReasoningMessage {
    type: 'reasoning';
    message: string;
    id: string;
}

export type ReasoningOutput = ReasoningToolCall | ReasoningToolResult | ReasoningMessage;

export class GeminiReasoningProcessor {
    private accumulator: string = '';
    private inTitleCapture: boolean = false;
    private titleBuffer: string = '';
    private contentBuffer: string = '';
    private hasTitle: boolean = false;
    private currentCallId: string | null = null;
    private toolCallStarted: boolean = false;
    private currentTitle: string | null = null;
    private onMessage: ((message: any) => void) | null = null;

    constructor(onMessage?: (message: any) => void) {
        this.onMessage = onMessage || null;
        this.reset();
    }

    /**
     * Set the message callback for sending messages directly
     */
    setMessageCallback(callback: (message: any) => void): void {
        this.onMessage = callback;
    }

    /**
     * Process a reasoning section break - indicates a new reasoning section is starting
     */
    handleSectionBreak(): void {
        this.finishCurrentToolCall('canceled');
        this.resetState();
        logger.debug('[GeminiReasoningProcessor] Section break - reset state');
    }

    /**
     * Process a reasoning chunk from agent_thought_chunk
     * Gemini sends reasoning as chunks, we accumulate them similar to Codex
     */
    processChunk(chunk: string): void {
        this.accumulator += chunk;

        // If we haven't started processing yet, check if this starts with **
        if (!this.inTitleCapture && !this.hasTitle && !this.contentBuffer) {
            if (this.accumulator.startsWith('**')) {
                // Start title capture
                this.inTitleCapture = true;
                this.titleBuffer = this.accumulator.substring(2); // Remove leading **
                logger.debug('[GeminiReasoningProcessor] Started title capture');
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
                
                logger.debug(`[GeminiReasoningProcessor] Title captured: "${title}"`);
                
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
     * Send the tool call start message
     */
    private sendToolCallStart(title: string): void {
        if (!this.currentCallId || this.toolCallStarted) {
            return;
        }

        const toolCall: ReasoningToolCall = {
            type: 'tool-call',
            name: 'GeminiReasoning',
            callId: this.currentCallId,
            input: {
                title: title
            },
            id: randomUUID()
        };

        logger.debug(`[GeminiReasoningProcessor] Sending tool call start for: "${title}"`);
        this.onMessage?.(toolCall);
        this.toolCallStarted = true;
    }

    /**
     * Complete the reasoning section with final text
     * Called when reasoning is complete (e.g., when status changes to idle)
     * Returns true if reasoning was actually completed, false if there was nothing to complete
     */
    complete(): boolean {
        const fullText = this.accumulator;
        
        // If there's no content accumulated, don't send anything
        if (!fullText.trim() && !this.toolCallStarted) {
            logger.debug('[GeminiReasoningProcessor] Complete called but no content accumulated, skipping');
            return false;
        }
        
        // Extract title and content if present
        let title: string | undefined;
        let content: string = fullText;
        
        if (fullText.startsWith('**')) {
            const titleEndIndex = fullText.indexOf('**', 2);
            if (titleEndIndex !== -1) {
                title = fullText.substring(2, titleEndIndex);
                content = fullText.substring(titleEndIndex + 2).trim();
            }
        }

        logger.debug(`[GeminiReasoningProcessor] Complete reasoning - Title: "${title}", Has content: ${content.length > 0}`);
        
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
            logger.debug('[GeminiReasoningProcessor] Sending tool call result');
            this.onMessage?.(toolResult);
        } else if (content.trim()) {
            // Send regular reasoning message for untitled reasoning (only if there's content)
            const reasoningMessage: ReasoningMessage = {
                type: 'reasoning',
                message: content,
                id: randomUUID()
            };
            logger.debug('[GeminiReasoningProcessor] Sending reasoning message');
            this.onMessage?.(reasoningMessage);
        }
        
        // Reset state after completion
        this.resetState();
        return true;
    }

    /**
     * Abort the current reasoning section
     */
    abort(): void {
        logger.debug('[GeminiReasoningProcessor] Abort called');
        this.finishCurrentToolCall('canceled');
        this.resetState();
    }

    /**
     * Reset the processor state
     */
    reset(): void {
        this.finishCurrentToolCall('canceled');
        this.resetState();
    }

    /**
     * Finish current tool call if one is in progress
     */
    private finishCurrentToolCall(status: 'completed' | 'canceled'): void {
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
            logger.debug(`[GeminiReasoningProcessor] Sending tool call result with status: ${status}`);
            this.onMessage?.(toolResult);
        }
    }

    /**
     * Reset internal state
     */
    private resetState(): void {
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
     * Get the current call ID for tool result matching
     */
    getCurrentCallId(): string | null {
        return this.currentCallId;
    }

    /**
     * Check if a tool call has been started
     */
    hasStartedToolCall(): boolean {
        return this.toolCallStarted;
    }
}
