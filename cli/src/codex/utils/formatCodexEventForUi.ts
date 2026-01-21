export function formatCodexEventForUi(msg: unknown): string | null {
    if (!msg || typeof msg !== 'object') {
        return null;
    }

    const m = msg as any;
    const type = m.type;

    if (type === 'error') {
        const raw = typeof m.message === 'string' ? m.message.trim() : '';
        return raw ? `Codex error: ${raw}` : 'Codex error';
    }

    if (type === 'stream_error') {
        const raw = typeof m.message === 'string' ? m.message.trim() : '';
        return raw ? `Codex stream error: ${raw}` : 'Codex stream error';
    }

    if (type === 'mcp_startup_update' && m.status?.state === 'failed') {
        const serverName = typeof m.server === 'string' && m.server.trim() ? m.server.trim() : 'unknown';
        const errorText = typeof m.status?.error === 'string' && m.status.error.trim() ? m.status.error.trim() : 'unknown error';
        return `MCP server "${serverName}" failed to start: ${errorText}`;
    }

    return null;
}
