import { describe, expect, it, vi } from 'vitest';
import {
    createMcpAppExternalLinkHandler,
    parseMcpAppExternalUrl,
} from './linkPolicy';

describe('MCP App external link policy', () => {
    it.each([
        ['https://example.com/path?value=1#section', false],
        ['https://xn--bcher-kva.example/', false],
        ['http://localhost:5173/demo', true],
        ['http://127.0.0.1:3000/demo', true],
        ['http://[::1]:8080/demo', true],
    ])('allows %s with development=%s when policy permits it', (url, development) => {
        expect(parseMcpAppExternalUrl(url, { development })).toEqual({
            ok: true,
            url: new URL(url).toString(),
        });
    });

    it.each([
        ['http://localhost:5173/demo', false],
        ['http://example.com/demo', true],
        ['https://user:pass@example.com/', false],
        ['javascript:alert(1)', true],
        ['data:text/html,hello', true],
        ['file:///private/secret', true],
        ['paws://session/secret', true],
        ['not a url', true],
    ])('rejects %s with development=%s', (url, development) => {
        expect(parseMcpAppExternalUrl(url, { development })).toEqual({
            ok: false,
            code: 'MCP_APP_BRIDGE_PROTOCOL',
        });
    });

    it('opens only after the existing confirmation surface accepts', async () => {
        const confirm = vi.fn(async () => true);
        const open = vi.fn(async () => {});
        const handle = createMcpAppExternalLinkHandler({
            development: false,
            confirm,
            open,
            copy: {
                title: 'Open external link?',
                message: 'This App wants to open a link outside Paws.',
                confirm: 'Open link',
                cancel: 'Cancel',
            },
        });

        await expect(handle('https://example.com/path')).resolves.toEqual({});

        expect(confirm).toHaveBeenCalledWith(
            'Open external link?',
            'This App wants to open a link outside Paws.',
            { cancelText: 'Cancel', confirmText: 'Open link' },
        );
        expect(open).toHaveBeenCalledWith('https://example.com/path');
    });

    it('returns permission denial without opening when confirmation is declined', async () => {
        const open = vi.fn(async () => {});
        const handle = createMcpAppExternalLinkHandler({
            development: false,
            confirm: vi.fn(async () => false),
            open,
            copy: { title: 'title', message: 'message', confirm: 'open', cancel: 'cancel' },
        });

        await expect(handle('https://example.com/path')).rejects.toMatchObject({
            code: 'MCP_APP_PERMISSION_DENIED',
            retryable: false,
        });
        expect(open).not.toHaveBeenCalled();
    });

    it('fails closed before confirmation for a blocked protocol', async () => {
        const confirm = vi.fn(async () => true);
        const open = vi.fn(async () => {});
        const handle = createMcpAppExternalLinkHandler({
            development: true,
            confirm,
            open,
            copy: { title: 'title', message: 'message', confirm: 'open', cancel: 'cancel' },
        });

        await expect(handle('javascript:alert(1)')).rejects.toMatchObject({
            code: 'MCP_APP_BRIDGE_PROTOCOL',
            retryable: false,
        });
        expect(confirm).not.toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
    });

    it('does not open after its View instance is cancelled during confirmation', async () => {
        let resolveConfirmation!: (approved: boolean) => void;
        const confirmation = new Promise<boolean>((resolve) => {
            resolveConfirmation = resolve;
        });
        const open = vi.fn(async () => {});
        const handle = createMcpAppExternalLinkHandler({
            development: false,
            confirm: vi.fn(async () => confirmation),
            open,
            copy: { title: 'title', message: 'message', confirm: 'open', cancel: 'cancel' },
        });
        const controller = new AbortController();
        const pending = handle('https://example.com/path', controller.signal);

        controller.abort();
        resolveConfirmation(true);

        await expect(pending).rejects.toMatchObject({ code: 'MCP_APP_SESSION_OFFLINE' });
        expect(open).not.toHaveBeenCalled();
    });
});
