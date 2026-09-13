/**
 * The subset of a chat row that turn segmentation reads. Kept structural so
 * both the display grouping (full `Message`) and the copy helper (a slimmer
 * shape) share one rule instead of drifting apart.
 */
export type TurnAssignable = {
    kind: string;
    /** Sent but not yet accepted by the agent; never starts a turn. */
    pending?: boolean;
    sendError?: string;
    /** Session-protocol turn id, present on agent rows from Happy sessions. */
    turn?: string;
};

/**
 * Assigns each row (newest-first) to an assistant turn, where turn 0 is the
 * most recent.
 *
 * A turn ends at a settled user message. It also ends where the session
 * protocol says so: when two agent rows carry different turn ids, they are
 * different answers even when the user message between them never reached
 * this device — another participant's message that was dropped, or history
 * that was trimmed. Without that rule the earlier answer would be folded into
 * the later turn's work group. Rows without a turn id (older daemons, CLI
 * sessions, permission placeholders, receipts) never start a turn on their
 * own, so sessions that predate turn ids keep the user-message rule only.
 */
export function assignTurns(messages: readonly TurnAssignable[]): number[] {
    const turnOf = new Array<number>(messages.length);
    let turn = 0;
    let turnId: string | undefined;
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.kind !== 'user-text' && msg.turn !== undefined) {
            if (turnId !== undefined && msg.turn !== turnId) {
                turn++;
            }
            turnId = msg.turn;
        }
        turnOf[i] = turn;
        if (msg.kind === 'user-text' && !msg.pending && msg.sendError === undefined) {
            turn++;
            // The next agent row (older) belongs to whatever turn preceded this
            // message; its id must not be compared with the one just left.
            turnId = undefined;
        }
    }
    return turnOf;
}
