/**
 * Every launch failure — a missing native binary, a bad auth token, a spawn
 * error — reaches the launchers as a thrown Error whose message is the only
 * clue about what actually went wrong. Reporting a bare "Process exited
 * unexpectedly" discards it, leaving the failure undiagnosable from the app
 * and forcing a dig through the CLI logs to recover a single line.
 */
export const MAX_LAUNCH_FAILURE_DETAIL = 300;

const BASE_MESSAGE = 'Process exited unexpectedly';

export function launchFailureMessage(error: unknown): string {
    if (!(error instanceof Error)) {
        return BASE_MESSAGE;
    }
    // Collapse whitespace: multi-line messages would otherwise break the
    // single-line status rendering on the client.
    const detail = error.message.replace(/\s+/g, ' ').trim();
    if (!detail) {
        return BASE_MESSAGE;
    }
    const truncated = detail.length > MAX_LAUNCH_FAILURE_DETAIL
        ? `${detail.slice(0, MAX_LAUNCH_FAILURE_DETAIL)}…`
        : detail;
    return `${BASE_MESSAGE}: ${truncated}`;
}
