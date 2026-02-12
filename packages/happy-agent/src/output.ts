import chalk from 'chalk';
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

function truncateId(id: string, len = 8): string {
    return id.length > len ? id.slice(0, len) : id;
}

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

function padRight(str: string, len: number): string {
    return str.length >= len ? str : str + ' '.repeat(len - str.length);
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
        return 'No sessions found.';
    }

    const headers = ['ID', 'NAME', 'PATH', 'STATUS', 'LAST ACTIVE'];
    const rows: string[][] = sessions.map(s => {
        const meta = (s.metadata ?? {}) as SessionMetadata;
        const name = extractSessionSummary(meta) ?? toNonEmptyString(meta.tag) ?? '-';
        const path = toNonEmptyString(meta.path) ?? '-';
        const status = s.active ? 'active' : 'inactive';
        const lastActive = formatTime(s.activeAt);
        return [truncateId(s.id), name, path, status, lastActive];
    });

    // Calculate column widths
    const widths = headers.map((h, i) => {
        const maxRow = rows.reduce((max, row) => Math.max(max, row[i].length), 0);
        return Math.max(h.length, maxRow);
    });

    const headerLine = headers.map((h, i) => padRight(h, widths[i])).join('  ');
    const separator = widths.map(w => '-'.repeat(w)).join('  ');
    const dataLines = rows.map(row => {
        return row.map((cell, i) => {
            if (i === 3) {
                // status column - colorize
                const padded = padRight(cell, widths[i]);
                return cell === 'active' ? chalk.green(padded) : chalk.dim(padded);
            }
            return padRight(cell, widths[i]);
        }).join('  ');
    });

    return [
        chalk.bold(headerLine),
        separator,
        ...dataLines,
    ].join('\n');
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

    const lines: string[] = [];

    lines.push(chalk.bold('Session: ') + session.id);
    if (tag) lines.push(chalk.bold('Tag: ') + tag);
    if (summary) lines.push(chalk.bold('Summary: ') + summary);
    if (path) lines.push(chalk.bold('Path: ') + path);
    if (host) lines.push(chalk.bold('Host: ') + host);
    if (lifecycleState) lines.push(chalk.bold('Lifecycle: ') + lifecycleState);

    lines.push(chalk.bold('Active: ') + (session.active ? chalk.green('yes') : chalk.dim('no')));
    lines.push(chalk.bold('Last Active: ') + formatTime(session.activeAt));

    if (state) {
        const requests = state.requests != null && typeof state.requests === 'object' ? Object.keys(state.requests).length : 0;
        const busy = state.controlledByUser === true || requests > 0;
        const agentStatus = busy ? chalk.yellow('busy') : chalk.green('idle');
        lines.push(chalk.bold('Agent: ') + agentStatus);
        if (requests > 0) {
            lines.push(chalk.bold('Pending Requests: ') + requests);
        }
    } else {
        lines.push(chalk.bold('Agent: ') + chalk.dim('no state'));
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
        return 'No messages.';
    }

    return messages.map(msg => {
        const content = msg.content as MessageContent | null;
        const role = content?.role ?? 'unknown';
        const timestamp = new Date(msg.createdAt).toLocaleString();

        let text: string;
        if (content?.content && typeof content.content === 'object' && content.content.text) {
            text = content.content.text;
        } else if (content?.content && typeof content.content === 'string') {
            text = content.content;
        } else {
            text = JSON.stringify(content);
        }

        const roleLabel = role === 'user'
            ? chalk.blue(role)
            : role === 'assistant'
                ? chalk.green(role)
                : chalk.dim(role);

        return `${chalk.dim(timestamp)} ${roleLabel}: ${text}`;
    }).join('\n');
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
