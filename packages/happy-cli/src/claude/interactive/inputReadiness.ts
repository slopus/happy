const ANSI_ESCAPE_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const TAIL_PROGRESS_PATTERN =
    /\b(?:spinner without transcript|no transcript|waiting for transcript|press esc to interrupt|esc to interrupt|ctrl\+c to cancel|tokens? remaining)\b|(?:^|\s)thinking\.{3}(?:\s|$)/i;
const STYLED_PROMPT_PATTERN = /^❯(?:\s+Try\s+"[^"]*")?$/;

export function isTerminalInputReady(raw: string): boolean {
    const meaningfulLines = meaningfulTerminalLines(raw);

    if (meaningfulLines.length === 0) {
        return false;
    }

    const tailLines = meaningfulLines.slice(-3);
    const tailText = tailLines.join('\n');
    if (TAIL_PROGRESS_PATTERN.test(tailText)) {
        return false;
    }

    const lastLine = meaningfulLines[meaningfulLines.length - 1];
    return isReadyPromptLine(lastLine);
}

export function hasTerminalInputPrompt(raw: string): boolean {
    return meaningfulTerminalLines(raw).some(isPromptLookingLine);
}

function meaningfulTerminalLines(raw: string): string[] {
    return raw
        .replace(/\r/g, '\n')
        .split('\n')
        .map((line) => stripAnsi(line).trim())
        .filter(Boolean);
}

function isReadyPromptLine(line: string): boolean {
    return line === '>' || STYLED_PROMPT_PATTERN.test(line);
}

function isPromptLookingLine(line: string): boolean {
    return line === '>' || line.startsWith('❯');
}

function stripAnsi(value: string): string {
    return value.replace(ANSI_ESCAPE_PATTERN, '');
}
