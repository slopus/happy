import { Session } from "@/sync/storageTypes";
import { Message } from "@/sync/typesMessage";
import { VOICE_CONFIG } from "../voiceConfig";

interface SessionMetadata {
    summary?: { text?: string };
    path?: string;
    machineId?: string;
    homeDir?: string;
    [key: string]: any;
}


/**
 * Format a permission request for natural language context
 */
export function formatPermissionRequest(
    sessionId: string,
    requestId: string,
    toolName: string,
    toolArgs: any
): string {
    return `[CLAUDE] Permission request (request_id: ${requestId}): Claude wants to use ${toolName} with arguments: ${JSON.stringify(toolArgs)}`;
}

//
// Message formatting
//

function humanizeToolCall(name: string, input: any, description: string | null): string {
    const d = description;
    switch (name) {
        case 'WebSearch':
            return `Web search tool: ${input?.query ?? d ?? 'searching'}`;
        case 'WebFetch':
            try {
                const domain = new URL(input?.url ?? '').hostname;
                return `Web fetch tool: ${domain}`;
            } catch {
                return `Web fetch tool: ${d ?? 'fetching a page'}`;
            }
        case 'Bash':
            return `Bash tool: ${d ?? input?.command ?? 'running a command'}`;
        case 'Read':
            const file = input?.file_path?.split('/').pop() ?? d ?? 'a file';
            return `Read tool: ${file}`;
        case 'Write':
            const writeFile = input?.file_path?.split('/').pop() ?? d ?? 'a file';
            return `Write tool: ${writeFile}`;
        case 'Edit':
            const editFile = input?.file_path?.split('/').pop() ?? d ?? 'a file';
            return `Edit tool: ${editFile}`;
        case 'Grep':
            return `Search tool: ${input?.pattern ?? d ?? 'searching code'}`;
        case 'Glob':
            return `File search tool: ${input?.pattern ?? d ?? 'finding files'}`;
        case 'Agent':
            return `Agent tool: ${d ?? input?.description ?? 'running a sub-agent'}`;
        case 'Skill':
            return `Skill tool: ${input?.skill ?? 'loading a skill'}`;
        case 'ToolSearch':
            return `Tool search: ${input?.query ?? 'looking up tools'}`;
        default:
            return `${name} tool`;
    }
}

const spokenToolCalls = new Set<string>();

export function formatMessage(message: Message): string | null {
    if (message.kind === 'agent-text' && message.isThinking) {
        return null;
    } else if (message.kind === 'agent-text') {
        return `[CLAUDE] Response: ${message.text}`;
    } else if (message.kind === 'user-text') {
        return `[USER] ${message.text}`;
    } else if (message.kind === 'tool-call' && !VOICE_CONFIG.DISABLE_TOOL_CALLS) {
        // Only speak each tool call once (first time seen, whether running or completed)
        if (spokenToolCalls.has(message.id)) {
            return null;
        }
        spokenToolCalls.add(message.id);
        return `[CLAUDE] ${humanizeToolCall(message.tool.name, message.tool.input, message.tool.description)}`;
    }
    return null;
}

export function formatNewSingleMessage(sessionId: string, message: Message): string | null {
    let formatted = formatMessage(message);
    if (!formatted) {
        return null;
    }
    return formatted;
}

export function formatNewMessages(sessionId: string, messages: Message[]): string | null {
    let formatted = [...messages].sort((a, b) => a.createdAt - b.createdAt).map(formatMessage).filter(Boolean);
    if (formatted.length === 0) {
        return null;
    }
    return formatted.join('\n');
}

export function formatHistory(sessionId: string, messages: Message[]): string {
    let messagesToFormat = VOICE_CONFIG.MAX_HISTORY_MESSAGES > 0
        ? messages.slice(0, VOICE_CONFIG.MAX_HISTORY_MESSAGES)
        : messages;
    let formatted = messagesToFormat.map(formatMessage).filter(Boolean);
    return 'History of messages in session: ' + sessionId + '\n\n' + formatted.join('\n\n');
}

//
// Session states
//

export function formatSessionFull(session: Session, messages: Message[]): string {
    const sessionName = session.metadata?.summary?.text;
    const sessionPath = session.metadata?.path;
    const lines: string[] = [];

    // Add session context
    lines.push(`# Session ID: ${session.id}`);
    lines.push(`# Project path: ${sessionPath}`);
    lines.push(`# Session summary:\n${sessionName}`);

    // Add session metadata if available
    if (session.metadata?.summary?.text) {
        lines.push('## Session Summary');
        lines.push(session.metadata.summary.text);
        lines.push('');
    }

    // Add history
    lines.push('## Our interaction history so far');
    lines.push('');
    lines.push(formatHistory(session.id, messages));

    return lines.join('\n\n');
}

export function formatSessionOffline(sessionId: string, metadata?: SessionMetadata): string {
    return `[CLAUDE] Status: session ${sessionId} went offline`;
}

export function formatSessionOnline(sessionId: string, metadata?: SessionMetadata): string {
    return `[CLAUDE] Status: session ${sessionId} came online`;
}

export function formatSessionFocus(sessionId: string, metadata?: SessionMetadata): string {
    return `[CLAUDE] Status: session ${sessionId} is now focused`;
}

export function formatReadyEvent(sessionId: string): string {
    return `[CLAUDE] Claude Code has finished working.`;
}

//
// Jargon glossary
//

const JARGON_PATTERNS = [
    /[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*/g,          // camelCase / PascalCase
    /[a-z]+(?:_[a-z]+)+/g,                             // snake_case
    /[A-Z]+(?:_[A-Z]+)+/g,                             // SCREAMING_CASE
    /(?:\.\/|\/)?(?:[\w.-]+\/)+[\w.-]+\.\w+/g,         // file paths
    /[a-z]+(?:-[a-z]+)+/g,                             // kebab-case (package names)
    /\b[a-zA-Z]\w+\.\w+(?:\.\w+)*/g,                  // dot notation (e.g. sync.sendMessage)
];

export function extractTerms(text: string): string[] {
    const terms: string[] = [];
    for (const pattern of JARGON_PATTERNS) {
        pattern.lastIndex = 0;
        for (const match of text.matchAll(pattern)) {
            const term = match[0];
            if (term.length >= 3 && term.length <= 80) {
                terms.push(term);
            }
        }
    }
    return terms;
}

const GLOSSARY_MAX_LENGTH = 900; // Stay under 1024 token limit

export function formatGlossary(terms: Set<string>): string | null {
    if (terms.size === 0) return null;
    const prefix = 'Glossary of technical terms for transcription accuracy:\n';
    const allTerms = [...terms];
    let result = prefix;
    for (const term of allTerms) {
        const next = result.length === prefix.length ? term : ', ' + term;
        if (result.length + next.length > GLOSSARY_MAX_LENGTH) break;
        result += next;
    }
    return result;
}

/**
 * Strip [CLAUDE] prefixes from formatted messages for TTS playback.
 */
export function stripVoicePrefix(text: string): string {
    return text
        .replace(/^\[CLAUDE\]\s*(Response:|Status:|Tool use:|Tool result:|Ready:)\s*/gm, '')
        .replace(/^\[CLAUDE\]\s*/gm, '')
        .trim();
}
