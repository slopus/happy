import type { InteractiveClaudeTerminalEvent } from './types';

export type TerminalObservation = {
    type: InteractiveClaudeTerminalEvent;
    message: string;
};

const MAX_DIAGNOSTIC_LENGTH = 240;

const USAGE_OR_AUTH_MESSAGE = 'Claude reported a usage or authentication problem.';
const PERMISSION_PROMPT_MESSAGE = 'Claude is asking for permission.';
const SPINNER_WITHOUT_TRANSCRIPT_MESSAGE = 'Claude appears to be running but has not emitted transcript output yet.';
const INPUT_PROMPT_MESSAGE = 'Claude is ready for input.';
const TERMINAL_PROCESS_ERROR_FALLBACK = 'Terminal reported an error.';

const urlPattern = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const localPathPattern =
    /(?:\/(?:Users|home|tmp|var|private|Volumes|opt|usr|etc)\/[^\s"'<>]+|[A-Za-z]:\\(?:Users|Temp|Windows|ProgramData)\\[^\s"'<>]+)/g;
const tokenPattern =
    /\b(?:sk-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]*(?:token|secret|key|api)[A-Za-z0-9_-]*-[A-Za-z0-9_-]{6,}|(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{12,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|[A-Fa-f0-9]{32,}|[A-Za-z0-9_/-]{40,}={0,2})\b/g;

function boundDiagnostic(input: string): string {
    if (input.length <= MAX_DIAGNOSTIC_LENGTH) {
        return input;
    }

    return `${input.slice(0, MAX_DIAGNOSTIC_LENGTH - 3).trimEnd()}...`;
}

export function sanitizeTerminalDiagnostic(input: string): string {
    const sanitized = input
        .replace(urlPattern, '[url]')
        .replace(localPathPattern, '[path]')
        .replace(tokenPattern, '[secret]')
        .replace(/\s+/g, ' ')
        .trim();

    return boundDiagnostic(sanitized);
}

export function classifyTerminalOutput(raw: string): TerminalObservation | null {
    const normalized = raw.replace(/\s+/g, ' ').trim();
    const lower = normalized.toLowerCase();

    if (!lower) {
        return null;
    }

    if (isUsageOrAuthError(lower)) {
        return { type: 'usage_or_auth_error', message: USAGE_OR_AUTH_MESSAGE };
    }

    if (isPermissionPrompt(lower)) {
        return { type: 'permission_prompt_visible', message: PERMISSION_PROMPT_MESSAGE };
    }

    if (isSpinnerWithoutTranscript(lower)) {
        return { type: 'spinner_without_transcript', message: SPINNER_WITHOUT_TRANSCRIPT_MESSAGE };
    }

    if (isInputPrompt(raw)) {
        return { type: 'input_prompt_visible', message: INPUT_PROMPT_MESSAGE };
    }

    if (isTerminalProcessError(lower)) {
        return {
            type: 'terminal_process_error',
            message: buildTerminalProcessErrorMessage(raw),
        };
    }

    return null;
}

function isUsageOrAuthError(lower: string): boolean {
    return /\b(?:usage limit|rate limit|quota exceeded|authentication|unauthorized|forbidden|invalid api key|api key invalid|login required|not logged in|auth(?:entication)? (?:failed|required|error)|payment required|credit balance)\b/.test(
        lower,
    );
}

function isPermissionPrompt(lower: string): boolean {
    return /\bdo you want to allow\b/.test(lower) || /\ballow .+\?\s*$/.test(lower) || /\b(?:approve|deny)\?\s*$/.test(lower);
}

function isSpinnerWithoutTranscript(lower: string): boolean {
    return /\b(?:spinner without transcript|no transcript|waiting for transcript|press esc to interrupt|esc to interrupt|ctrl\+c to cancel|tokens? remaining)\b/.test(
        lower,
    ) || /(?:^|\s)thinking\.{3}(?:\s|$)/.test(lower);
}

function isInputPrompt(raw: string): boolean {
    return raw.split(/\r?\n/).some((line) => line.trim() === '>');
}

function isTerminalProcessError(lower: string): boolean {
    return /\b(?:error|failed|failure|exception|traceback|panic|eacces|enoent|timed out|timeout|permission denied|command not found)\b/.test(
        lower,
    );
}

function buildTerminalProcessErrorMessage(raw: string): string {
    const diagnostic = sanitizeTerminalDiagnostic(raw);

    if (!diagnostic) {
        return TERMINAL_PROCESS_ERROR_FALLBACK;
    }

    return boundDiagnostic(`${TERMINAL_PROCESS_ERROR_FALLBACK} ${diagnostic}`);
}
