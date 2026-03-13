export type SessionTurnState = {
    thinking: boolean;
    awaitingTurnStart: boolean;
    dispatching: boolean;
    lastHeartbeatAt: number;
};

/**
 * Per-session runtime state machine:
 * - idle (thinking=false, awaitingTurnStart=false, dispatching=false)
 * - dispatching (beginDispatch -> dispatching=true)
 * - awaitingTurnStart (markDispatched after enqueue/send-now/direct-send)
 * - thinking (markTurnStarted / thinking heartbeat true)
 * - back to idle (thinking heartbeat false and no awaiting/dispatching)
 *
 * Note: this is an in-memory coordination guard for a single server process.
 * Cross-process ordering must be enforced by database-side operations.
 */
const runtimeBySession = new Map<string, SessionTurnState>();

function ensureSessionState(sessionId: string): SessionTurnState {
    const existing = runtimeBySession.get(sessionId);
    if (existing) {
        return existing;
    }

    const created: SessionTurnState = {
        thinking: false,
        awaitingTurnStart: false,
        dispatching: false,
        lastHeartbeatAt: 0,
    };
    runtimeBySession.set(sessionId, created);
    return created;
}

export function getSessionTurnState(sessionId: string): SessionTurnState {
    return { ...ensureSessionState(sessionId) };
}

export function isSessionThinking(sessionId: string): boolean {
    return ensureSessionState(sessionId).thinking;
}

export function isSessionBusy(sessionId: string): boolean {
    const state = ensureSessionState(sessionId);
    return state.thinking || state.awaitingTurnStart || state.dispatching;
}

export function canDispatch(sessionId: string): boolean {
    const state = ensureSessionState(sessionId);
    return !state.thinking && !state.awaitingTurnStart && !state.dispatching;
}

export function beginDispatch(sessionId: string): boolean {
    const state = ensureSessionState(sessionId);
    if (!canDispatch(sessionId)) {
        return false;
    }

    state.dispatching = true;
    return true;
}

export function finishDispatch(sessionId: string): void {
    const state = ensureSessionState(sessionId);
    state.dispatching = false;
}

export function markDispatched(sessionId: string): void {
    const state = ensureSessionState(sessionId);
    state.awaitingTurnStart = true;
}

export function markTurnStarted(sessionId: string): void {
    const state = ensureSessionState(sessionId);
    state.thinking = true;
    state.awaitingTurnStart = false;
    state.dispatching = false;
}

export function updateThinkingState(sessionId: string, thinking: boolean, timestampMs: number): {
    thinkingChanged: boolean;
    turnStarted: boolean;
    turnEnded: boolean;
    current: SessionTurnState;
} {
    const state = ensureSessionState(sessionId);
    const previousThinking = state.thinking;

    if (thinking) {
        markTurnStarted(sessionId);
    } else {
        state.thinking = false;
    }

    state.lastHeartbeatAt = timestampMs;

    const turnStarted = !previousThinking && thinking;
    const turnEnded = previousThinking && !thinking;

    return {
        thinkingChanged: previousThinking !== thinking,
        turnStarted,
        turnEnded,
        current: { ...state },
    };
}

export function clearSessionTurnState(sessionId: string): void {
    runtimeBySession.delete(sessionId);
}

export function __resetSessionTurnRuntimeForTests(): void {
    runtimeBySession.clear();
}
