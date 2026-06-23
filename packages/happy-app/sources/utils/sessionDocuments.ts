import * as React from 'react';
import type { GitStatusFiles } from '@/sync/gitStatusFiles';
import type { Metadata } from '@/sync/storageTypes';
import type { Message, ToolCall } from '@/sync/typesMessage';
import {
    loadSessionDocumentIndex,
    saveSessionDocumentIndex,
    type PersistedSessionDocumentItem,
} from '@/sync/persistence';

export type SessionDocumentType = 'markdown' | 'code' | 'image' | 'data' | 'document' | 'other';
export type SessionDocumentStatus = 'created' | 'modified' | 'deleted';
export type SessionDocumentSource = 'tool' | 'git';

export type SessionDocumentItem = {
    path: string;
    name: string;
    ext: string | null;
    type: SessionDocumentType;
    status: SessionDocumentStatus;
    source: SessionDocumentSource;
    messageId?: string;
    updatedAt: number;
};

const MAX_SESSION_DOCUMENTS = 500;

export function useSessionDocumentIndex(
    sessionId: string,
    messages: Message[],
    metadata: Metadata | null,
    gitStatusFiles: GitStatusFiles | null,
): SessionDocumentItem[] {
    const [items, setItems] = React.useState<SessionDocumentItem[]>(() => loadSessionDocumentIndex(sessionId).map(fromPersistedItem));

    React.useEffect(() => {
        setItems(loadSessionDocumentIndex(sessionId).map(fromPersistedItem));
    }, [sessionId]);

    const discoveredItems = React.useMemo(() => (
        collectSessionDocumentItems(messages, metadata, gitStatusFiles)
    ), [messages, metadata, gitStatusFiles]);

    React.useEffect(() => {
        if (discoveredItems.length === 0) return;
        setItems((previous) => {
            const merged = mergeSessionDocumentItems(previous, discoveredItems);
            if (areDocumentItemsEqual(previous, merged)) return previous;
            saveSessionDocumentIndex(sessionId, merged.map(toPersistedItem));
            return merged;
        });
    }, [discoveredItems, sessionId]);

    return items;
}

export function collectSessionDocumentItems(
    messages: Message[],
    metadata: Metadata | null,
    gitStatusFiles: GitStatusFiles | null,
): SessionDocumentItem[] {
    const items: SessionDocumentItem[] = [];

    for (const message of messages) {
        collectMessageDocumentItems(message, metadata, items);
    }

    const gitFiles = [
        ...(gitStatusFiles?.stagedFiles ?? []),
        ...(gitStatusFiles?.unstagedFiles ?? []),
    ];
    for (const file of gitFiles) {
        items.push(createDocumentItem({
            path: file.fullPath,
            status: mapGitStatus(file.status),
            source: 'git',
            updatedAt: Date.now(),
        }));
    }

    return mergeSessionDocumentItems([], items);
}

export function mergeSessionDocumentItems(existing: SessionDocumentItem[], incoming: SessionDocumentItem[]): SessionDocumentItem[] {
    const byPath = new Map<string, SessionDocumentItem>();
    for (const item of existing) {
        byPath.set(item.path, item);
    }
    for (const item of incoming) {
        const previous = byPath.get(item.path);
        const latest = !previous || item.updatedAt >= previous.updatedAt ? item : previous;
        byPath.set(item.path, {
            ...latest,
            source: previous?.source === 'tool' ? previous.source : item.source,
            messageId: latest.messageId ?? item.messageId ?? previous?.messageId,
            updatedAt: Math.max(previous?.updatedAt ?? 0, item.updatedAt),
        });
    }
    return Array.from(byPath.values())
        .sort((a, b) => b.updatedAt - a.updatedAt || a.path.localeCompare(b.path))
        .slice(0, MAX_SESSION_DOCUMENTS);
}

function collectMessageDocumentItems(message: Message, metadata: Metadata | null, acc: SessionDocumentItem[]) {
    if (message.kind !== 'tool-call') return;
    collectToolDocumentItems(message.tool, message.id, metadata, acc);
    for (const child of message.children) {
        collectMessageDocumentItems(child, metadata, acc);
    }
}

function collectToolDocumentItems(tool: ToolCall, messageId: string, metadata: Metadata | null, acc: SessionDocumentItem[]) {
    const updatedAt = tool.completedAt ?? tool.startedAt ?? tool.createdAt ?? Date.now();
    const addPath = (path: unknown, status: SessionDocumentStatus) => {
        if (typeof path !== 'string') return;
        const normalizedPath = normalizeDocumentPath(path, metadata);
        if (!normalizedPath) return;
        acc.push(createDocumentItem({
            path: normalizedPath,
            status,
            source: 'tool',
            messageId,
            updatedAt,
        }));
    };

    switch (tool.name) {
        case 'Write':
            addPath(tool.input?.file_path, 'created');
            break;
        case 'Edit':
        case 'MultiEdit':
            addPath(tool.input?.file_path, 'modified');
            break;
        case 'NotebookEdit':
            addPath(tool.input?.notebook_path, 'modified');
            break;
        case 'CodexPatch':
        case 'GeminiPatch':
            collectPatchDocumentItems(tool, messageId, metadata, acc);
            break;
        case 'CodexBash':
            collectCodexBashDocumentItems(tool, messageId, metadata, acc);
            break;
        case 'edit':
            collectGeminiEditDocumentItems(tool, messageId, metadata, acc);
            break;
        default:
            break;
    }
}

function collectPatchDocumentItems(tool: ToolCall, messageId: string, metadata: Metadata | null, acc: SessionDocumentItem[]) {
    const changes = getPatchChanges(tool.input);
    if (!changes) return;
    const updatedAt = tool.completedAt ?? tool.startedAt ?? tool.createdAt ?? Date.now();
    for (const [path, change] of Object.entries(changes)) {
        const normalizedPath = normalizeDocumentPath(path, metadata);
        if (!normalizedPath) continue;
        acc.push(createDocumentItem({
            path: normalizedPath,
            status: mapPatchStatus(change),
            source: 'tool',
            messageId,
            updatedAt,
        }));
        if (typeof change?.kind?.move_path === 'string') {
            const movePath = normalizeDocumentPath(change.kind.move_path, metadata);
            if (movePath) {
                acc.push(createDocumentItem({
                    path: movePath,
                    status: 'modified',
                    source: 'tool',
                    messageId,
                    updatedAt,
                }));
            }
        }
    }
}

function collectCodexBashDocumentItems(tool: ToolCall, messageId: string, metadata: Metadata | null, acc: SessionDocumentItem[]) {
    const parsed = tool.input?.parsed_cmd;
    if (!Array.isArray(parsed)) return;
    const updatedAt = tool.completedAt ?? tool.startedAt ?? tool.createdAt ?? Date.now();
    for (const command of parsed) {
        if (!command || typeof command !== 'object') continue;
        const type = typeof command.type === 'string' ? command.type : '';
        const name = typeof command.name === 'string' ? command.name : null;
        if (!name || (type !== 'write' && type !== 'edit')) continue;
        const normalizedPath = normalizeDocumentPath(name, metadata);
        if (!normalizedPath) continue;
        acc.push(createDocumentItem({
            path: normalizedPath,
            status: type === 'write' ? 'created' : 'modified',
            source: 'tool',
            messageId,
            updatedAt,
        }));
    }
}

function collectGeminiEditDocumentItems(tool: ToolCall, messageId: string, metadata: Metadata | null, acc: SessionDocumentItem[]) {
    const locations = tool.input?.locations;
    const updatedAt = tool.completedAt ?? tool.startedAt ?? tool.createdAt ?? Date.now();
    if (Array.isArray(locations)) {
        for (const location of locations) {
            if (!location || typeof location !== 'object') continue;
            const path = typeof location.path === 'string' ? location.path : null;
            if (!path) continue;
            const normalizedPath = normalizeDocumentPath(path, metadata);
            if (!normalizedPath) continue;
            acc.push(createDocumentItem({
                path: normalizedPath,
                status: 'modified',
                source: 'tool',
                messageId,
                updatedAt,
            }));
        }
    }
}

function getPatchChanges(input: any): Record<string, any> | null {
    if (input?.changes && typeof input.changes === 'object' && !Array.isArray(input.changes)) {
        return input.changes;
    }
    if (input?.fileChanges && typeof input.fileChanges === 'object' && !Array.isArray(input.fileChanges)) {
        return input.fileChanges;
    }
    return null;
}

function normalizeDocumentPath(path: string, metadata: Metadata | null): string | null {
    const trimmed = path.trim();
    if (!trimmed || trimmed.length > 1000 || /[\r\n]/.test(trimmed)) return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
    if (metadata?.path && trimmed.toLowerCase().startsWith(metadata.path.toLowerCase())) {
        const remainder = trimmed.slice(metadata.path.length).replace(/^[/\\]+/, '');
        return remainder || null;
    }
    return trimmed.replace(/^[.][/\\]/, '');
}

function createDocumentItem(input: {
    path: string;
    status: SessionDocumentStatus;
    source: SessionDocumentSource;
    messageId?: string;
    updatedAt: number;
}): SessionDocumentItem {
    const name = getFileName(input.path);
    const ext = getExtension(name);
    return {
        path: input.path,
        name,
        ext,
        type: getDocumentType(ext),
        status: input.status,
        source: input.source,
        messageId: input.messageId,
        updatedAt: input.updatedAt,
    };
}

function getFileName(path: string): string {
    const parts = path.split(/[/\\]/);
    return parts[parts.length - 1] || path;
}

function getExtension(name: string): string | null {
    const index = name.lastIndexOf('.');
    if (index <= 0 || index === name.length - 1) return null;
    return name.slice(index + 1).toLowerCase();
}

function getDocumentType(ext: string | null): SessionDocumentType {
    if (!ext) return 'other';
    if (['md', 'mdx', 'markdown', 'txt', 'rst'].includes(ext)) return 'markdown';
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic', 'avif'].includes(ext)) return 'image';
    if (['json', 'jsonl', 'csv', 'tsv', 'yaml', 'yml', 'toml', 'xml'].includes(ext)) return 'data';
    if (['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx'].includes(ext)) return 'document';
    if ([
        'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'java', 'go', 'rs', 'rb', 'php', 'swift',
        'kt', 'kts', 'c', 'h', 'cpp', 'hpp', 'cs', 'sh', 'bash', 'zsh', 'fish', 'sql', 'html',
        'css', 'scss', 'less', 'vue', 'svelte', 'astro', 'lua', 'r', 'dart',
    ].includes(ext)) return 'code';
    return 'other';
}

function mapGitStatus(status: string): SessionDocumentStatus {
    if (status === 'added' || status === 'untracked') return 'created';
    if (status === 'deleted') return 'deleted';
    return 'modified';
}

function mapPatchStatus(change: any): SessionDocumentStatus {
    if (change?.kind?.type === 'add') return 'created';
    if (change?.kind?.type === 'delete') return 'deleted';
    if (change?.add) return 'created';
    if (change?.delete) return 'deleted';
    return 'modified';
}

function fromPersistedItem(item: PersistedSessionDocumentItem): SessionDocumentItem {
    return {
        path: item.path,
        name: item.name,
        ext: item.ext,
        type: isSessionDocumentType(item.type) ? item.type : getDocumentType(item.ext),
        status: isSessionDocumentStatus(item.status) ? item.status : 'modified',
        source: item.source === 'tool' ? 'tool' : 'git',
        messageId: item.messageId,
        updatedAt: item.updatedAt,
    };
}

function toPersistedItem(item: SessionDocumentItem): PersistedSessionDocumentItem {
    return item;
}

function isSessionDocumentType(value: string): value is SessionDocumentType {
    return value === 'markdown' || value === 'code' || value === 'image' || value === 'data' || value === 'document' || value === 'other';
}

function isSessionDocumentStatus(value: string): value is SessionDocumentStatus {
    return value === 'created' || value === 'modified' || value === 'deleted';
}

function areDocumentItemsEqual(a: SessionDocumentItem[], b: SessionDocumentItem[]): boolean {
    if (a.length !== b.length) return false;
    return JSON.stringify(a) === JSON.stringify(b);
}
