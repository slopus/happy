// Kept out of sessionUtils so it stays testable: that module imports React,
// which pulls in react-native's Flow-typed entry point and cannot be loaded in
// the node test environment. The type import below is erased at compile time.
import type { SessionState } from './sessionUtils';

/**
 * Whether the "new results" marker may stand in for the live status of `state`.
 *
 * Unread is a fact about history — there is output you have not looked at yet.
 * The states describe the present: what the session is doing right now. When the
 * two disagree the present has to win, because it is the part that is still
 * changing and the part that may still need you.
 *
 * `permission_required` is the case that matters. A session blocked on a
 * permission prompt or an open question makes no progress until someone answers
 * it, and letting unread paint over it hides exactly that: the row reads "new
 * results" while the session sits waiting, and nothing says to open it.
 * `thinking` is milder — both render blue, so unread only costs the pulse — but
 * it still describes work in flight.
 *
 * Written as an allowlist rather than as an exclusion of the two attention
 * states, so a state added later keeps its own display until someone decides
 * otherwise. A new state is likelier to be one that needs attention than another
 * idle one, and that is the safer way to be wrong.
 */
export function unreadMayOverride(state: SessionState): boolean {
    return state === 'waiting' || state === 'disconnected';
}
