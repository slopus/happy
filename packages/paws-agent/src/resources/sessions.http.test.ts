import { createServer, type Server } from 'node:http';
import { inspect } from 'node:util';
import axios, { type AxiosInstance } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PawsAgentError } from '../client/errors';
import { RecordEncryptionStore } from '../crypto/records';
import { PawsHttpTransport } from '../transport/http';
import { SessionsResourceImpl } from './sessions';

describe('Codex spawn authorization over HTTP', () => {
    let server: Server;
    let transport: PawsHttpTransport;
    let sessions: SessionsResourceImpl;
    let status: number;
    let body: string;
    let disconnect: boolean;
    let holdResponse: boolean;
    let httpClient: AxiosInstance;
    let requests: Array<{ method?: string; path?: string; body: string }>;
    const machineRpc = vi.fn();

    beforeEach(async () => {
        status = 409;
        body = JSON.stringify({ error: 'codex-account-unbound' });
        disconnect = false;
        holdResponse = false;
        httpClient = axios.create({ proxy: false });
        requests = [];
        machineRpc.mockReset().mockResolvedValue({ type: 'success', sessionId: 'local-session' });
        server = createServer(async (request, response) => {
            let received = '';
            for await (const chunk of request) received += chunk;
            requests.push({ method: request.method, path: request.url, body: received });
            if (disconnect) {
                request.socket.destroy();
                return;
            }
            if (holdResponse) return;
            response.writeHead(status, { 'Content-Type': 'application/json' });
            response.end(body);
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing fixture address');
        transport = new PawsHttpTransport({
            client: httpClient,
            serverUrl: `http://127.0.0.1:${address.port}`,
            credentials: { setCredentials: async () => {}, clearCredentials: async () => {}, getCredentials: async () => ({
                token: 'fixture-paws-token', secret: new Uint8Array(32),
                contentKeyPair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) },
            }) },
        });
        sessions = new SessionsResourceImpl(transport, { machineRpc } as never,
            new RecordEncryptionStore(), async () => [{ id: 'machine-1' }] as never);
    });

    afterEach(async () => {
        transport?.dispose();
        server?.closeAllConnections();
        await new Promise<void>((resolve, reject) => server?.close(error => error ? reject(error) : resolve()));
    });

    const input = { machineId: 'machine-1', directory: '/study', agent: 'codex' as const };

    it('uses the local login only after an explicit HTTP 409 unbound response', async () => {
        await expect(sessions.spawn(input)).resolves.toEqual({ type: 'success', sessionId: 'local-session' });
        expect(requests).toEqual([{ method: 'POST', path: '/v1/codex-session-grants', body: '{"machineId":"machine-1"}' }]);
        expect(machineRpc).toHaveBeenCalledExactlyOnceWith('machine-1', 'spawn-happy-session', {
            type: 'spawn-in-directory', directory: '/study', approvedNewDirectoryCreation: false,
            token: undefined, agent: 'codex',
        });
    });

    it('still forwards a fresh valid grant for a bound machine', async () => {
        status = 200;
        body = JSON.stringify({ grant: 'g'.repeat(43) });
        await expect(sessions.spawn(input)).resolves.toMatchObject({ type: 'success' });
        expect(machineRpc).toHaveBeenCalledWith('machine-1', 'spawn-happy-session', expect.objectContaining({ codexSessionGrant: 'g'.repeat(43) }));
    });

    it.each([
        [401, { error: 'codex-account-unbound' }],
        [403, { error: 'codex-account-unbound' }],
        [404, { error: 'codex-account-unbound' }],
        [429, { error: 'codex-account-unbound' }],
        [500, { error: 'codex-account-unbound' }],
        [502, { error: 'codex-account-unbound' }],
        [409, { error: 'codex-account-unavailable' }],
        [409, { error: 'profile-not-found' }],
        [409, { error: 'machine-not-found' }],
        [409, { error: 'grant-unavailable' }],
        [409, { message: 'codex-account-unbound' }],
        [409, { error: { code: 'codex-account-unbound' } }],
        [409, [{ error: 'codex-account-unbound' }]],
        [409, 'codex-account-unbound'],
        [200, { error: 'codex-account-unbound' }],
        [200, { grant: 'bad' }],
        [200, { grant: '!'.repeat(43) }],
        [200, {}],
        [200, null],
    ])('fails closed for HTTP %i with response %j', async (httpStatus, responseBody) => {
        status = httpStatus;
        body = JSON.stringify(responseBody);
        await expect(sessions.spawn(input)).rejects.toMatchObject({ name: 'PawsAgentError' });
        expect(machineRpc).not.toHaveBeenCalled();
    });

    it('does not treat malformed JSON containing the unbound code as an authorization decision', async () => {
        body = '{"error":"codex-account-unbound"';
        await expect(sessions.spawn(input)).rejects.toMatchObject({ name: 'PawsAgentError' });
        expect(machineRpc).not.toHaveBeenCalled();
    });

    it('does not fall back after a network failure', async () => {
        disconnect = true;
        await expect(sessions.spawn(input)).rejects.toMatchObject({ name: 'PawsAgentError' });
        expect(machineRpc).not.toHaveBeenCalled();
    });

    it('does not fall back after an HTTP timeout', async () => {
        holdResponse = true;
        httpClient.defaults.timeout = 50;
        await expect(sessions.spawn(input)).rejects.toMatchObject({ code: 'RPC_TIMEOUT' });
        expect(machineRpc).not.toHaveBeenCalled();
    });

    it('does not fall back when the in-flight grant request is cancelled', async () => {
        holdResponse = true;
        const spawning = sessions.spawn(input);
        const rejected = expect(spawning).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
        await vi.waitFor(() => expect(requests).toHaveLength(1));
        transport.dispose();
        await rejected;
        expect(machineRpc).not.toHaveBeenCalled();
    });

    it('keeps only the allowlisted unbound decision when a response also contains sensitive extras', async () => {
        body = JSON.stringify({ error: 'codex-account-unbound', access_token: 'fixture-secret-token', grant: 'fixture-secret-grant' });
        const error = await transport.post('/v1/codex-session-grants', {}).catch(error => error);
        expect(error).toMatchObject({ name: 'PawsAgentError' });
        if (!(error instanceof PawsAgentError)) throw new Error('Expected a normalized HTTP error');
        expect(error.details).toEqual({ status: 409, errorCode: 'codex-account-unbound' });
        expect(JSON.stringify(error)).not.toContain('fixture-secret');
        expect(inspect(error, { depth: null, showHidden: true })).not.toContain('fixture-secret');
        expect(error.cause).toBeUndefined();
        await expect(sessions.spawn(input)).resolves.toMatchObject({ type: 'success' });
        expect(JSON.stringify(machineRpc.mock.calls)).not.toContain('fixture-secret');
        expect(machineRpc.mock.calls[0][2]).not.toHaveProperty('codexSessionGrant');
    });

    it('leaves Claude outside the Codex grant workflow', async () => {
        await expect(sessions.spawn({ ...input, agent: 'claude', providerToken: 'fixture-provider-token' }))
            .resolves.toMatchObject({ type: 'success' });
        expect(requests).toEqual([]);
        expect(machineRpc).toHaveBeenCalledWith('machine-1', 'spawn-happy-session', expect.objectContaining({ agent: 'claude', token: 'fixture-provider-token' }));
    });

    it('never copies arbitrary server response data into serialized errors', async () => {
        body = JSON.stringify({ error: 'fixture-secret-token', grant: 'fixture-secret-grant' });
        const error = await transport.post('/v1/codex-session-grants', {}).catch(error => error);
        expect(error).toMatchObject({ name: 'PawsAgentError' });
        expect(JSON.stringify(error)).not.toContain('fixture-secret');
        expect(JSON.stringify(error)).not.toContain('fixture-paws-token');
    });
});
