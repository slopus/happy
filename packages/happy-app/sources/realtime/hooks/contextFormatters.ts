import { Session } from "@/sync/storageTypes";
import { Message } from "@/sync/typesMessage";
import { trimIdent } from "@/utils/trimIdent";
import { VOICE_CONFIG } from "../voiceConfig";
import { getSessionName } from "@/utils/sessionUtils";
import { storage } from "@/sync/storage";

interface SessionMetadata {
    summary?: { text?: string };
    path?: string;
    machineId?: string;
    homeDir?: string;
    [key: string]: any;
}

/**
 * Get a short, voice-friendly label for a session.
 * Prefers the folder name (short, stable) over the summary (long, changes).
 */
export function getSessionLabel(session: Session): string {
    if (session.metadata?.path) {
        const segments = session.metadata.path.split('/').filter(Boolean);
        return segments.pop() || session.id.slice(0, 8);
    }
    return getSessionName(session);
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
    const session = storage.getState().sessions[sessionId];
    const label = session ? getSessionLabel(session) : sessionId.slice(0, 8);
    return trimIdent(`
        Claude Code in "${label}" is requesting permission to use ${toolName}:
        <request_id>${requestId}</request_id>
        <session_name>${label}</session_name>
        <tool_name>${toolName}</tool_name>
        <tool_args>${JSON.stringify(toolArgs)}</tool_args>
    `);
}

//
// Message formatting
//

export function formatMessage(message: Message): string | null {

    // Lines
    let lines: string[] = [];
    if (message.kind === 'agent-text') {
        lines.push(`Claude Code: \n<text>${message.text}</text>`);
    } else if (message.kind === 'user-text') {
        lines.push(`User sent message: \n<text>${message.text}</text>`);
    } else if (message.kind === 'tool-call' && !VOICE_CONFIG.DISABLE_TOOL_CALLS) {
        const toolDescription = message.tool.description ? ` - ${message.tool.description}` : '';
        if (VOICE_CONFIG.LIMITED_TOOL_CALLS) {
            if (message.tool.description) {
                lines.push(`Claude Code is using ${message.tool.name}${toolDescription}`);
            }
        } else {
            lines.push(`Claude Code is using ${message.tool.name}${toolDescription} (tool_use_id: ${message.id}) with arguments: <arguments>${JSON.stringify(message.tool.input)}</arguments>`);
        }
    }
    if (lines.length === 0) {
        return null;
    }
    return lines.join('\n\n');
}

export function formatNewSingleMessage(sessionId: string, message: Message): string | null {
    let formatted = formatMessage(message);
    if (!formatted) {
        return null;
    }
    const session = storage.getState().sessions[sessionId];
    const label = session ? getSessionLabel(session) : sessionId.slice(0, 8);
    return `New message in "${label}":\n\n` + formatted;
}

export function formatNewMessages(sessionId: string, messages: Message[]): string | null {
    let formatted = [...messages].sort((a, b) => a.createdAt - b.createdAt).map(formatMessage).filter(Boolean);
    if (formatted.length === 0) {
        return null;
    }
    const session = storage.getState().sessions[sessionId];
    const label = session ? getSessionLabel(session) : sessionId.slice(0, 8);
    return `New messages in "${label}":\n\n` + formatted.join('\n\n');
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
    const label = getSessionLabel(session);
    const sessionName = session.metadata?.summary?.text;
    const sessionPath = session.metadata?.path;
    const lines: string[] = [];

    // Add session context with voice-friendly label
    lines.push(`# Session "${label}" (ID: ${session.id})`);
    lines.push(`# Project path: ${sessionPath}`);
    if (sessionName) {
        lines.push(`# Summary: ${sessionName}`);
    }

    // Add history
    lines.push('## Interaction history');
    lines.push('');
    lines.push(formatHistory(session.id, messages));

    return lines.join('\n\n');
}

function labelFromMetadata(sessionId: string, metadata?: SessionMetadata): string {
    if (metadata?.path) {
        const segments = metadata.path.split('/').filter(Boolean);
        return segments.pop() || sessionId.slice(0, 8);
    }
    if (metadata?.summary?.text) {
        return metadata.summary.text.slice(0, 40);
    }
    return sessionId.slice(0, 8);
}

export function formatSessionOffline(sessionId: string, metadata?: SessionMetadata): string {
    return `Session "${labelFromMetadata(sessionId, metadata)}" went offline.`;
}

export function formatSessionOnline(sessionId: string, metadata?: SessionMetadata): string {
    return `Session "${labelFromMetadata(sessionId, metadata)}" came online.`;
}

export function formatSessionFocus(sessionId: string, metadata?: SessionMetadata): string {
    return `User is now looking at session "${labelFromMetadata(sessionId, metadata)}".`;
}

export function formatReadyEvent(sessionId: string): string {
    const session = storage.getState().sessions[sessionId];
    const label = session ? getSessionLabel(session) : sessionId.slice(0, 8);
    return `Claude Code finished working in "${label}". The previous message(s) are the summary of the work done. Report this to the human immediately.`;
}