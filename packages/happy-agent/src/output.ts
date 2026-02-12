import chalk from 'chalk';
import type { DecryptedSession } from './api';

// --- Types ---

type SessionMetadata = {
    path?: string;
    host?: string;
    tag?: string;
    summary?: string;
    lifecycleState?: string;
    [key: string]: unknown;
};

type AgentState = {
    controlledByUser?: boolean;
    requests?: unknown[];
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

// --- Session list formatting ---

export function formatSessionTable(sessions: DecryptedSession[]): string {
    if (sessions.length === 0) {
        return 'No sessions found.';
    }

    const headers = ['ID', 'NAME', 'PATH', 'STATUS', 'LAST ACTIVE'];
    const rows: string[][] = sessions.map(s => {
        const meta = (s.metadata ?? {}) as SessionMetadata;
        const name = meta.summary || meta.tag || '-';
        const path = meta.path || '-';
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

    const lines: string[] = [];

    lines.push(chalk.bold('Session: ') + session.id);
    if (meta.tag) lines.push(chalk.bold('Tag: ') + meta.tag);
    if (meta.summary) lines.push(chalk.bold('Summary: ') + meta.summary);
    if (meta.path) lines.push(chalk.bold('Path: ') + meta.path);
    if (meta.host) lines.push(chalk.bold('Host: ') + meta.host);
    if (meta.lifecycleState) lines.push(chalk.bold('Lifecycle: ') + meta.lifecycleState);

    lines.push(chalk.bold('Active: ') + (session.active ? chalk.green('yes') : chalk.dim('no')));
    lines.push(chalk.bold('Last Active: ') + formatTime(session.activeAt));

    if (state) {
        const busy = state.controlledByUser === true;
        const requests = Array.isArray(state.requests) ? state.requests.length : 0;
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

// --- JSON output ---

export function formatJson(data: unknown): string {
    return JSON.stringify(data, null, 2);
}

// --- Output dispatcher ---

export function outputResult(data: unknown, json: boolean, formatter: (data: unknown) => string): void {
    if (json) {
        console.log(formatJson(data));
    } else {
        console.log(formatter(data));
    }
}
