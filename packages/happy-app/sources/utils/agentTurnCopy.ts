export type AgentTurnCopyMessage = {
    id: string;
    kind: string;
    text?: string;
    isThinking?: boolean;
};

/**
 * Builds the copy payload for each completed assistant turn and attaches it to
 * that turn's final text block. Messages are newest-first, while copied text
 * should read in chronological order.
 */
export function buildAgentTurnCopyTextByMessageId(
    messages: readonly AgentTurnCopyMessage[],
    options: { currentTurnComplete: boolean },
): Map<string, string> {
    const messagesByTurn = new Map<number, AgentTurnCopyMessage[]>();
    let turn = 0;

    for (const message of messages) {
        if (message.kind === 'agent-text' && !message.isThinking && message.text?.trim()) {
            const turnMessages = messagesByTurn.get(turn) ?? [];
            turnMessages.push(message);
            messagesByTurn.set(turn, turnMessages);
        }
        if (message.kind === 'user-text') {
            turn++;
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