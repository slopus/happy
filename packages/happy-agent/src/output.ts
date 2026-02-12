import type { DecryptedSession, DecryptedMessage } from './api';

// --- Types ---

type SessionMetadata = {
    path?: string;
    host?: string;
    tag?: string;
    summary?: string | { text?: unknown; [key: string]: unknown };
    lifecycleState?: string;
    [key: string]: unknown;
};

type AgentState = {
    controlledByUser?: boolean;
    requests?: Record<string, unknown>;
    [key: string]: unknown;
};

// --- Helpers ---

function formatTime(ts: number): string {
    if (!ts) return '-';
    const date = new Date(ts);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60_000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    return `${diffDay}d ago`;
}

function formatIsoTime(ts: number): string {
    if (!ts) return '-';
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) return '-';
    return date.toISOString();
}

function formatLastActive(ts: number): string {
    const relative = formatTime(ts);
    const absolute = formatIsoTime(ts);
    if (absolute === '-') return relative;
    return `${relative} (${absolute})`;
}

function toMarkdownInline(value: string): string {
    const escaped = value.replace(/`/g, '\\`');
    return `\`${escaped}\``;
}

function normalizeCodeBlockText(value: string): string {
    const text = value.trim().length > 0 ? value : '(empty)';
    return text.replace(/```/g, '``\\`');
}

function normalizeListValue(value: string): string {
    return value.replace(/\r?\n/g, ' ').trim();
}

function toNonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function extractSessionSummary(meta: SessionMetadata): string | undefined {
    const direct = toNonEmptyString(meta.summary);
    if (direct) return direct;
    if (meta.summary != null && typeof meta.summary === 'object') {
        return toNonEmptyString((meta.summary as { text?: unknown }).text);
    }
    return undefined;
}

// --- Session list formatting ---

export function formatSessionTable(sessions: DecryptedSession[]): string {
    if (sessions.length === 0) {
        return '## Sessions\n\n- Total: 0\n- Items: none';
    }

    const sections = sessions.map((s, index) => {
        const meta = (s.metadata ?? {}) as SessionMetadata;
        const name = normalizeListValue(extractSessionSummary(meta) ?? toNonEmptyString(meta.tag) ?? '-');
        const path = normalizeListValue(toNonEmptyString(meta.path) ?? '-');
        const status = s.active ? 'active' : 'inactive';
        const lastActive = normalizeListValue(formatLastActive(s.activeAt));
        return [
            `### Session ${index + 1}`,
            `- ID: ${toMarkdownInline(s.id)}`,
            `- Name: ${name}`,
            `- Path: ${path}`,
            `- Status: ${status}`,
            `- Last Active: ${lastActive}`,
        ].join('\n');
    });

    return `## Sessions\n\n- Total: ${sessions.length}\n\n${sections.join('\n\n')}`;
}

// --- Session status formatting ---

export function formatSessionStatus(session: DecryptedSession): string {
    const meta = (session.metadata ?? {}) as SessionMetadata;
    const state = (session.agentState ?? null) as AgentState | null;
    const tag = toNonEmptyString(meta.tag);
    const summary = extractSessionSummary(meta);
    const path = toNonEmptyString(meta.path);
    const host = toNonEmptyString(meta.host);
    const lifecycleState = toNonEmptyString(meta.lifecycleState);

    const lines: string[] = [
        '## Session Status',
        '',
        `- Session ID: ${toMarkdownInline(session.id)}`,
    ];
    if (tag) lines.push(`- Tag: ${tag}`);
    if (summary) lines.push(`- Summary: ${summary}`);
    if (path) lines.push(`- Path: ${path}`);
    if (host) lines.push(`- Host: ${host}`);
    if (lifecycleState) lines.push(`- Lifecycle: ${lifecycleState}`);
    lines.push(`- Active: ${session.active ? 'yes' : 'no'}`);
    lines.push(`- Last Active: ${formatLastActive(session.activeAt)}`);

    if (state) {
        const requests = state.requests != null && typeof state.requests === 'object' ? Object.keys(state.requests).length : 0;
        const busy = state.controlledByUser === true || requests > 0;
        const agentStatus = busy ? 'busy' : 'idle';
        lines.push(`- Agent: ${agentStatus}`);
        if (requests > 0) {
            lines.push(`- Pending Requests: ${requests}`);
        }
    } else {
        lines.push('- Agent: no state');
    }

    return lines.join('\n');
}

// --- Message history formatting ---

type MessageContent = {
    role?: string;
    content?: { type?: string; text?: string } | string;
    [key: string]: unknown;
};

export function formatMessageHistory(messages: DecryptedMessage[]): string {
    if (messages.length === 0) {
        return '## Message History\n\n- Count: 0\n- Items: none';
    }

    const sections = messages.map((msg, index) => {
        const content = msg.content as MessageContent | null;
        const role = content?.role ?? 'unknown';
        const timestamp = formatIsoTime(msg.createdAt);

        let text: string;
        if (content?.content && typeof content.content === 'object' && content.content.text) {
            text = String(content.content.text);
        } else if (content?.content && typeof content.content === 'string') {
            text = content.content;
        } else {
            text = JSON.stringify(content);
        }

        return [
            `### Message ${index + 1}`,
            `- ID: ${toMarkdownInline(msg.id)}`,
            `- Time: ${timestamp}`,
            `- Role: ${role}`,
            '- Text:',
            '```text',
            normalizeCodeBlockText(text),
            '```',
        ].join('\n');
    });

    return `## Message History\n\n- Count: ${messages.length}\n\n${sections.join('\n\n')}`;
}

// --- JSON output ---

export function formatJson(data: unknown): string {
    return JSON.stringify(data, (key, value) => {
        // Strip encryption keys from output
        if (key === 'encryption' || key === 'dataEncryptionKey') return undefined;
        // Serialize Uint8Array as base64
        if (value instanceof Uint8Array) {
            return Buffer.from(value).toString('base64');
        }
        return value;
    }, 2);
}
