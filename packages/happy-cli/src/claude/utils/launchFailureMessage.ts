/**
 * Every launch failure — a missing native binary, a bad auth token, a spawn
 * error — reaches the launchers as a thrown Error whose message is the only
 * clue about what actually went wrong. Reporting a bare "Process exited
 * unexpectedly" discards it, leaving the failure undiagnosable from the app
 * and forcing a dig through the CLI logs to recover a single line.
 */
export const MAX_LAUNCH_FAILURE_DETAIL = 300;

const BASE_MESSAGE = 'Process exited unexpectedly';

// Claude's own advice for a model its version predates is `claude update`, but
// sessions started from the app run the Claude Code bundled with Happy's Agent
// SDK, which only a newer Happy replaces. Matched before truncation and
// appended after it, so a long detail cannot cut the hint off.
const OUTDATED_BUNDLED_CLAUDE = /does not support this model|version \S+ or newer is required/i;
const UPDATE_HAPPY_HINT = 'App sessions use the Claude Code bundled with Happy; update it with `npm i -g happy@latest`.';

export function launchFailureMessage(error: unknown): string {
    if (!(error instanceof Error)) {
        return BASE_MESSAGE;
    }
    // Strip ANSI escape sequences and stray control characters first — child
    // process errors can carry colored output, and the message is rendered
    // verbatim in the app. Then collapse whitespace: multi-line messages
    // would otherwise break the single-line status rendering on the client.
    const detail = error.message
        .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!detail) {
        return BASE_MESSAGE;
    }
    const truncated = detail.length > MAX_LAUNCH_FAILURE_DETAIL
        ? `${detail.slice(0, MAX_LAUNCH_FAILURE_DETAIL)}…`
        : detail;
    const hint = OUTDATED_BUNDLED_CLAUDE.test(detail) ? ` ${UPDATE_HAPPY_HINT}` : '';
    return `${BASE_MESSAGE}: ${truncated}${hint}`;
}
