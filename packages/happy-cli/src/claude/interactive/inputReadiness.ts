const ANSI_ESCAPE_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const TAIL_PROGRESS_PATTERN =
    /\b(?:spinner without transcript|no transcript|waiting for transcript|press esc to interrupt|esc to interrupt|ctrl\+c to cancel|tokens? remaining)\b|(?:^|\s)thinking\.{3}(?:\s|$)/i;
const STYLED_PROMPT_PATTERN = /^❯(?:\s+Try\s+"[^"]*")?$/;

export function isTerminalInputReady(raw: string): boolean {
    const meaningfulLines = raw
        .replace(/\r/g, '\n')
        .split('\n')
        .map((line) => stripAnsi(line).trim())
        .filter(Boolean);

    if (meaningfulLines.length === 0) {
        return false;
    }

    const tailLines = meaningfulLines.slice(-3);
    const tailText = tailLines.join('\n');
    if (TAIL_PROGRESS_PATTERN.test(tailText)) {
        return false;
    }

    const lastLine = meaningfulLines[meaningfulLines.length - 1];
    return lastLine === '>' || STYLED_PROMPT_PATTERN.test(lastLine);
}

function stripAnsi(value: string): string {
    return value.replace(ANSI_ESCAPE_PATTERN, '');
}
