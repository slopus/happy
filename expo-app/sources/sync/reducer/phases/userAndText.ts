import type { TracedMessage } from '../reducerTracer';
import type { UsageData } from '../../typesRaw';
import type { ReducerState } from '../reducer';
import { normalizeThinkingChunk, unwrapThinkingText, wrapThinkingText } from '../helpers/thinkingText';

export function runUserAndTextPhase(params: Readonly<{
    state: ReducerState;
    nonSidechainMessages: TracedMessage[];
    changed: Set<string>;
    allocateId: () => string;
    processUsageData: (state: ReducerState, usage: UsageData, timestamp: number) => void;
    lastMainThinkingMessageId: string | null;
    lastMainThinkingCreatedAt: number | null;
}>): Readonly<{
    lastMainThinkingMessageId: string | null;
    lastMainThinkingCreatedAt: number | null;
}> {
    const {
        state,
        nonSidechainMessages,
        changed,
        allocateId,
        processUsageData,
    } = params;

    let lastMainThinkingMessageId = params.lastMainThinkingMessageId;
    let lastMainThinkingCreatedAt = params.lastMainThinkingCreatedAt;

    //
    // Phase 1: Process non-sidechain user messages and text messages
    //

    for (let msg of nonSidechainMessages) {
        if (msg.role === 'user') {
            // Check if we've seen this localId before
            if (msg.localId && state.localIds.has(msg.localId)) {
                continue;
            }
            // Check if we've seen this message ID before
            if (state.messageIds.has(msg.id)) {
                continue;
            }

            // Create a new message
            let mid = allocateId();
            state.messages.set(mid, {
                id: mid,
                realID: msg.id,
                role: 'user',
                createdAt: msg.createdAt,
                text: msg.content.text,
                tool: null,
                event: null,
                meta: msg.meta,
            });

            // Track both localId and messageId
            if (msg.localId) {
                state.localIds.set(msg.localId, mid);
            }
            state.messageIds.set(msg.id, mid);

            changed.add(mid);
            lastMainThinkingMessageId = null;
            lastMainThinkingCreatedAt = null;
        } else if (msg.role === 'agent') {
            // Check if we've seen this agent message before
            if (state.messageIds.has(msg.id)) {
                continue;
            }

            // Mark this message as seen
            state.messageIds.set(msg.id, msg.id);

            // Process usage data if present
            if (msg.usage) {
                processUsageData(state, msg.usage, msg.createdAt);
            }

            // Process text and thinking content (tool calls handled in Phase 2)
            for (let c of msg.content) {
                if (c.type === 'text') {
                    let mid = allocateId();
                    state.messages.set(mid, {
                        id: mid,
                        realID: msg.id,
                        role: 'agent',
                        createdAt: msg.createdAt,
                        text: c.text,
                        isThinking: false,
                        tool: null,
                        event: null,
                        meta: msg.meta,
                    });
                    changed.add(mid);
                    lastMainThinkingMessageId = null;
                    lastMainThinkingCreatedAt = null;
                } else if (c.type === 'thinking') {
                    const chunk = typeof c.thinking === 'string' ? normalizeThinkingChunk(c.thinking) : '';
                    if (!chunk.trim()) {
                        continue;
                    }

                    const prevThinkingId = lastMainThinkingMessageId;
                    const canAppendToPrevious =
                        prevThinkingId
                        && lastMainThinkingCreatedAt !== null
                        && msg.createdAt - lastMainThinkingCreatedAt < 120_000
                        && (() => {
                            const prev = state.messages.get(prevThinkingId);
                            return prev?.role === 'agent' && prev.isThinking && typeof prev.text === 'string';
                        })();

                    if (canAppendToPrevious) {
                        const prev = prevThinkingId ? state.messages.get(prevThinkingId) : null;
                        if (prev && typeof prev.text === 'string') {
                            const merged = unwrapThinkingText(prev.text) + chunk;
                            prev.text = wrapThinkingText(merged);
                            changed.add(prevThinkingId!);
                        }
                    } else {
                        let mid = allocateId();
                        state.messages.set(mid, {
                            id: mid,
                            realID: msg.id,
                            role: 'agent',
                            createdAt: msg.createdAt,
                            text: wrapThinkingText(chunk),
                            isThinking: true,
                            tool: null,
                            event: null,
                            meta: msg.meta,
                        });
                        changed.add(mid);
                        lastMainThinkingMessageId = mid;
                        lastMainThinkingCreatedAt = msg.createdAt;
                    }
                }
            }
        }
    }

    return { lastMainThinkingMessageId, lastMainThinkingCreatedAt };
}

