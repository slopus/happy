import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Socket } from 'socket.io-client';
import { ApiSessionClient } from './apiSession';
import { encodeBase64, encrypt } from './encryption';
import { configuration } from '@/configuration';
import type { Session, Update, UserMessage } from './types';

/** Real encrypted HTTP catch-up requests, including a live event racing the
 * response. No API client, transport implementation, or encryption is mocked. */
describe('resumed session input catch-up', () => {
    const originalServerUrl = configuration.serverUrl;
    const server = createServer();
    let client: ApiSessionClient;
    let session: Session;
    let directory: string;
    let seen: UserMessage[];
    let requests: number[];
    let failNextRequest: boolean;
    let holdResponse: boolean;
    let heldResponse: ServerResponse | undefined;
    let requestArrived: Promise<void>;
    let announceRequest: () => void;
    let rows: Array<{ id: string; seq: number; localId: string; content: { t: 'encrypted'; c: string }; createdAt: number; updatedAt: number }>;

    function addMessage(seq: number, text: string) {
        const content = encodeBase64(encrypt(session.encryptionKey, session.encryptionVariant,
            { role: 'user', content: { type: 'text', text } }));
        const row = { id: `message-${seq}`, seq, localId: `input-${seq}`,
            content: { t: 'encrypted' as const, c: content }, createdAt: seq, updatedAt: seq };
        rows.push(row);
        return row;
    }

    function fetchMessages() {
        return (client as unknown as { fetchMessages(): Promise<void> }).fetchMessages();
    }

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'paws-reconnect-'));
        requests = []; rows = []; seen = []; failNextRequest = false; holdResponse = false;
        heldResponse = undefined;
        requestArrived = new Promise(resolve => { announceRequest = resolve; });
        session = { id: 'resumed-session', seq: 10, metadataVersion: 0, agentStateVersion: 0,
            agentState: null, encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy',
            metadata: { path: directory, host: 'test', homeDir: directory, happyHomeDir: directory,
                happyLibDir: directory, happyToolsDir: directory } };
        server.removeAllListeners('request');
        server.on('request', (request, response) => {
            const url = new URL(request.url!, 'http://localhost');
            if (url.pathname !== '/v3/sessions/resumed-session/messages') {
                response.writeHead(404).end(); return;
            }
            const after = Number(url.searchParams.get('after_seq'));
            requests.push(after);
            announceRequest();
            if (failNextRequest) {
                failNextRequest = false; response.writeHead(500).end(); return;
            }
            if (holdResponse) { heldResponse = response; return; }
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({ messages: rows.filter(row => row.seq > after), hasMore: false }));
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing test server address');
        Object.defineProperty(configuration, 'serverUrl', { value: `http://127.0.0.1:${address.port}`, configurable: true });
        client = new ApiSessionClient('test-token', session);
        client.skipExistingMessages();
        client.onUserMessage(message => seen.push(message));
    });

    afterEach(async () => {
        heldResponse?.destroy();
        await client?.close();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        Object.defineProperty(configuration, 'serverUrl', { value: originalServerUrl, configurable: true });
        await rm(directory, { recursive: true, force: true });
    });

    it('skips only the resume snapshot and delivers input arriving before the first catch-up', async () => {
        addMessage(10, 'already executed before resume');
        addMessage(11, 'queued while the worker was starting');
        await fetchMessages();
        expect(requests).toEqual([10]);
        expect(seen.map(message => message.content.text)).toEqual(['queued while the worker was starting']);
        await fetchMessages();
        expect(seen).toHaveLength(1);
    });

    it('retains the historical boundary when the first catch-up request fails', async () => {
        addMessage(10, 'old business request');
        addMessage(11, 'new request');
        failNextRequest = true;
        await expect(fetchMessages()).rejects.toThrow();
        await fetchMessages();
        expect(requests).toEqual([10, 10]);
        expect(seen.map(message => message.content.text)).toEqual(['new request']);
    });

    it('does not dispatch a live input again when an in-flight catch-up returns it', async () => {
        const row = addMessage(11, 'execute once');
        holdResponse = true;
        const fetching = fetchMessages();
        await requestArrived;
        const update: Update = { id: 'live-update', seq: 1, createdAt: 1,
            body: { t: 'new-message', sid: session.id, message: row } };
        const socket = (client as unknown as { socket: Socket }).socket;
        // Inject the actual decoded Socket.IO event while the real HTTP
        // response is held; both paths must share the receive cursor.
        (socket as unknown as { emitEvent(args: unknown[]): void }).emitEvent(['update', update]);
        heldResponse!.setHeader('content-type', 'application/json');
        heldResponse!.end(JSON.stringify({ messages: [row], hasMore: false }));
        await fetching;
        expect(seen.map(message => message.content.text)).toEqual(['execute once']);
    });
});
