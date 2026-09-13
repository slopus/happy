import { assignTurns } from './agentTurns';

export type AgentTurnCopyMessage = {
    id: string;
    kind: string;
    text?: string;
    isThinking?: boolean;
    pending?: boolean;
    sendError?: string;
    turn?: string;
};

/**
 * Builds the copy payload for each completed assistant turn and attaches it to
 * that turn's final text block. Messages are newest-first, while copied text
 * should read in chronological order.
 *
 * Turn boundaries come from `assignTurns`, the same rule the chat uses to fold
 * a finished turn's work: a pending message has not started a turn, and a
 * change of turn id is a boundary even without a user row. Diverging from the
 * chat here would hand a still-streaming reply a copy button that shifts the
 * row on every token.
 */
export function buildAgentTurnCopyTextByMessageId(
    messages: readonly AgentTurnCopyMessage[],
    options: { currentTurnComplete: boolean },
): Map<string, string> {
    const messagesByTurn = new Map<number, AgentTurnCopyMessage[]>();
    const turnOf = assignTurns(messages);

    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        if (message.kind === 'agent-text' && !message.isThinking && message.text?.trim()) {
            const turnMessages = messagesByTurn.get(turnOf[i]) ?? [];
            turnMessages.push(message);
            messagesByTurn.set(turnOf[i], turnMessages);
        }
    }

    const result = new Map<string, string>();
    for (const [turnNumber, turnMessagesNewestFirst] of messagesByTurn) {
        if (turnNumber === 0 && !options.currentTurnComplete) {
            continue;
        }
        const finalMessage = turnMessagesNewestFirst[0];
        const copyText = [...turnMessagesNewestFirst]
            .reverse()
            .map((message) => message.text!.trim())
            .join('\n\n');
        if (finalMessage && copyText) {
            result.set(finalMessage.id, copyText);
        }
    }

    return result;
}
