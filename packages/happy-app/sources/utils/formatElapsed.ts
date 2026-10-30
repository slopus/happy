/**
 * Label for a running tool's elapsed time. useElapsedTime counts whole
 * seconds, so the label does too: `8s`, then `1m 05s` past a minute.
 */
export function formatElapsed(seconds: number): string {
    const whole = Math.max(0, Math.floor(seconds));
    if (whole < 60) return `${whole}s`;
    const minutes = Math.floor(whole / 60);
    return `${minutes}m ${String(whole % 60).padStart(2, '0')}s`;
}
