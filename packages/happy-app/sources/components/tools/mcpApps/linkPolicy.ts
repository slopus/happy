import { McpAppHostError } from './types';

export type McpAppExternalUrlResult =
    | { ok: true; url: string }
    | { ok: false; code: 'MCP_APP_BRIDGE_PROTOCOL' };

const DEVELOPMENT_HTTP_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function parseMcpAppExternalUrl(
    rawUrl: string,
    options: { development: boolean },
): McpAppExternalUrlResult {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return { ok: false, code: 'MCP_APP_BRIDGE_PROTOCOL' };
    }
    if (url.username || url.password) {
        return { ok: false, code: 'MCP_APP_BRIDGE_PROTOCOL' };
    }
    const allowed = url.protocol === 'https:'
        || (options.development
            && url.protocol === 'http:'
            && DEVELOPMENT_HTTP_HOSTS.has(url.hostname));
    return allowed
        ? { ok: true, url: url.toString() }
        : { ok: false, code: 'MCP_APP_BRIDGE_PROTOCOL' };
}

function cancellationError(): McpAppHostError {
    return new McpAppHostError(
        'MCP_APP_SESSION_OFFLINE',
        true,
        'The session is no longer available.',
    );
}

export function createMcpAppExternalLinkHandler(options: {
    development: boolean;
    confirm(
        title: string,
        message: string,
        options: { cancelText: string; confirmText: string },
    ): Promise<boolean>;
    open(url: string): Promise<void>;
    copy: { title: string; message: string; confirm: string; cancel: string };
}): (rawUrl: string, signal?: AbortSignal) => Promise<Record<string, never>> {
    return async (rawUrl, signal) => {
        if (signal?.aborted) throw cancellationError();
        const parsed = parseMcpAppExternalUrl(rawUrl, { development: options.development });
        if (!parsed.ok) {
            throw new McpAppHostError(
                parsed.code,
                false,
                'The external link is not allowed.',
            );
        }

        const approved = await options.confirm(
            options.copy.title,
            options.copy.message,
            { cancelText: options.copy.cancel, confirmText: options.copy.confirm },
        );
        if (signal?.aborted) throw cancellationError();
        if (!approved) {
            throw new McpAppHostError(
                'MCP_APP_PERMISSION_DENIED',
                false,
                'Permission was denied.',
            );
        }
        try {
            await options.open(parsed.url);
        } catch {
            throw new McpAppHostError(
                'MCP_APP_INTERNAL',
                false,
                'The App request could not be completed.',
            );
        }
        if (signal?.aborted) throw cancellationError();
        return {};
    };
}
