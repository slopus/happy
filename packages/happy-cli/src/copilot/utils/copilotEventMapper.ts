/**
 * Copilot Event Mapper
 * 
 * Maps Copilot CLI JSONL events (from events.jsonl) to Happy session
 * protocol envelopes for relay to the mobile app.
 * 
 * Copilot JSONL event types:
 * - session.start → session metadata
 * - user.message → user text  
 * - assistant.turn_start / assistant.turn_end → turn boundaries
 * - assistant.message → agent text output
 * - tool.execution_start → tool call (name, args)
 * - tool.execution_complete → tool result
 */

import { createId } from '@paralleldrive/cuid2';
import { createEnvelope, type SessionEnvelope, type CreateEnvelopeOptions } from '@slopus/happy-wire';

/** Raw Copilot JSONL event */
export interface CopilotEvent {
    type: string;
    data: Record<string, unknown>;
    id: string;
    timestamp: string;
    parentId: string | null;
}

/**
 * Stateful mapper that tracks turn context across events.
 */
export class CopilotEventMapper {
    private currentTurnId: string | null = null;
    private lastTime = 0;
    private toolCallIdMap = new Map<string, string>();

    private nextTime(): number {
        this.lastTime = Math.max(this.lastTime + 1, Date.now());
        return this.lastTime;
    }

    private turnOptions(): CreateEnvelopeOptions {
        return this.currentTurnId
            ? { turn: this.currentTurnId, time: this.nextTime() }
            : { time: this.nextTime() };
    }

    private ensureToolCallId(copilotId: string): string {
        const existing = this.toolCallIdMap.get(copilotId);
        if (existing) return existing;
        const id = createId();
        this.toolCallIdMap.set(copilotId, id);
        return id;
    }

    /**
     * Map a Copilot JSONL event to zero or more Happy session envelopes.
     */
    mapEvent(event: CopilotEvent): SessionEnvelope[] {
        switch (event.type) {
            case 'assistant.turn_start':
                return this.handleTurnStart();
            case 'assistant.turn_end':
                return this.handleTurnEnd();
            case 'assistant.message':
                return this.handleAssistantMessage(event.data);
            case 'tool.execution_start':
                return this.handleToolStart(event.data);
            case 'tool.execution_complete':
                return this.handleToolComplete(event.data);
            case 'user.message':
                return this.handleUserMessage(event.data);
            case 'session.start':
                return this.handleSessionStart(event.data);
            default:
                return [];
        }
    }

    private handleSessionStart(_data: Record<string, unknown>): SessionEnvelope[] {
        return [
            createEnvelope('agent', { t: 'start' }, { time: this.nextTime() }),
        ];
    }

    private handleTurnStart(): SessionEnvelope[] {
        if (this.currentTurnId) return [];
        this.currentTurnId = createId();
        this.toolCallIdMap.clear();
        return [
            createEnvelope('agent', { t: 'turn-start' }, { turn: this.currentTurnId, time: this.nextTime() }),
        ];
    }

    private handleTurnEnd(): SessionEnvelope[] {
        if (!this.currentTurnId) return [];
        const turnId = this.currentTurnId;
        this.currentTurnId = null;
        this.toolCallIdMap.clear();
        return [
            createEnvelope('agent', { t: 'turn-end', status: 'completed' }, { turn: turnId, time: this.nextTime() }),
        ];
    }

    private handleAssistantMessage(data: Record<string, unknown>): SessionEnvelope[] {
        const content = data.content;
        if (typeof content !== 'string' || !content.trim()) return [];
        return [
            createEnvelope('agent', { t: 'text', text: content }, this.turnOptions()),
        ];
    }

    private handleUserMessage(data: Record<string, unknown>): SessionEnvelope[] {
        const content = data.content;
        if (typeof content !== 'string' || !content.trim()) return [];

        // Close current agent turn before emitting user message (same as Claude)
        const envelopes: SessionEnvelope[] = [];
        if (this.currentTurnId) {
            const turnId = this.currentTurnId;
            this.currentTurnId = null;
            this.toolCallIdMap.clear();
            envelopes.push(
                createEnvelope('agent', { t: 'turn-end', status: 'completed' }, { turn: turnId, time: this.nextTime() }),
            );
        }

        envelopes.push(
            createEnvelope('user', { t: 'text', text: content }, { time: this.nextTime() }),
        );
        return envelopes;
    }

    private handleToolStart(data: Record<string, unknown>): SessionEnvelope[] {
        const toolCallId = data.toolCallId as string;
        const toolName = data.toolName as string || 'unknown';
        const args = (data.arguments as Record<string, unknown>) || {};

        if (!toolCallId) return [];

        const call = this.ensureToolCallId(toolCallId);
        const mappedName = mapCopilotToolName(toolName);

        return [
            createEnvelope('agent', {
                t: 'tool-call-start',
                call,
                name: mappedName,
                title: (args.description as string) || mappedName,
                description: (args.command as string) || `Running ${mappedName}`,
                args,
            }, this.turnOptions()),
        ];
    }

    private handleToolComplete(data: Record<string, unknown>): SessionEnvelope[] {
        const toolCallId = data.toolCallId as string;
        if (!toolCallId) return [];

        const call = this.ensureToolCallId(toolCallId);
        const result = data.result as Record<string, unknown> | undefined;
        const envelopes: SessionEnvelope[] = [];

        // Emit result text if available
        if (result) {
            const content = (result.content as string) || (result.detailedContent as string);
            if (content && content.trim()) {
                envelopes.push(
                    createEnvelope('agent', { t: 'text', text: content }, this.turnOptions()),
                );
            }
        }

        envelopes.push(
            createEnvelope('agent', { t: 'tool-call-end', call }, this.turnOptions()),
        );

        return envelopes;
    }
}

/** Map Copilot tool names to Claude-compatible names for the app */
function mapCopilotToolName(toolName: string): string {
    switch (toolName) {
        case 'powershell':
        case 'shell':
        case 'terminal':
        case 'run_command':
            return 'Bash';
        case 'edit':
        case 'edit_file':
            return 'Edit';
        case 'create':
        case 'write_file':
            return 'Write';
        case 'view':
        case 'read_file':
        case 'read':
            return 'Read';
        case 'grep':
        case 'glob':
        case 'search':
            return 'Search';
        case 'task':
        case 'general-purpose':
            return 'Task';
        default:
            return toolName;
    }
}
