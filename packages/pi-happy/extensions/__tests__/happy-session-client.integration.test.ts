import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';

import { afterEach, describe, expect, it } from 'vitest';
import { Server as SocketIoServer } from 'socket.io';
import { deriveContentKeyPair, getRandomBytes } from 'happy-agent/encryption';

import type { PiHappyLegacyCredentials } from '../credentials';
import {
  HappySessionClient,
  type HappySessionMetadata,
} from '../happy-session-client';
import { ConnectionState } from '../types';

type RunningMockServer = {
  serverUrl: string;
  close: () => Promise<void>;
  whenConnected: () => Promise<void>;
};

async function readJsonBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
}

async function startMockServer(port?: number): Promise<RunningMockServer> {
  let latestConnectionResolve: (() => void) | null = null;
  let latestConnectionPromise = new Promise<void>(resolve => {
    latestConnectionResolve = resolve;
  });
  let messageSeq = 0;

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (req.method === 'POST' && url.pathname === '/v1/sessions') {
      const body = await readJsonBody(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        session: {
          id: 'integration-session',
          seq: 1,
          metadata: body.metadata,
          metadataVersion: 1,
          agentState: body.agentState,
          agentStateVersion: body.agentState ? 1 : 0,
        },
      }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/sessions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions: [] }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v3/sessions/integration-session/messages') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messages: [], hasMore: false }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v3/sessions/integration-session/messages') {
      const body = await readJsonBody(req);
      const messages = Array.isArray(body?.messages) ? body.messages : [];
      const responseMessages = messages.map((message: { localId: string | null }, index: number) => {
        messageSeq += 1;
        return {
          id: `message-${messageSeq}`,
          seq: messageSeq,
          localId: message.localId ?? `local-${index}`,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messages: responseMessages }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  const ioServer = new SocketIoServer(httpServer, {
    path: '/v1/updates',
    transports: ['websocket'],
    cors: { origin: '*' },
  });

  ioServer.on('connection', socket => {
    latestConnectionResolve?.();
    latestConnectionPromise = new Promise<void>(resolve => {
      latestConnectionResolve = resolve;
    });

    socket.on('ping', callback => {
      callback();
    });

    socket.on('update-metadata', (_data, callback) => {
      callback({ result: 'error' });
    });

    socket.on('update-state', (_data, callback) => {
      callback({ result: 'error' });
    });
  });

  httpServer.listen(port ?? 0, '127.0.0.1');
  await once(httpServer, 'listening');
  const address = httpServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to determine mock server address');
  }

  return {
    serverUrl: `http://127.0.0.1:${address.port}`,
    whenConnected: async () => latestConnectionPromise,
    close: async () => {
      await new Promise<void>(resolve => {
        ioServer.close(() => {
          httpServer.close(() => resolve());
        });
      });
    },
  };
}

function makeLegacyCredentials(): PiHappyLegacyCredentials {
  const secret = getRandomBytes(32);
  return {
    token: 'integration-token',
    encryption: {
      type: 'legacy',
      secret,
    },
    contentKeyPair: deriveContentKeyPair(secret),
  };
}

function makeMetadata(): HappySessionMetadata {
  return {
    path: '/tmp/project',
    host: 'localhost',
    homeDir: '/Users/steve',
    happyHomeDir: '/Users/steve/.happy',
    happyLibDir: '',
    happyToolsDir: '',
  };
}

async function waitFor(check: () => void, timeoutMs: number = 5_000): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      check();
      return;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }

  throw lastError;
}

describe('HappySessionClient integration', () => {
  const servers: RunningMockServer[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop();
      if (server) {
        await server.close();
      }
    }
  });

  it('reconnects to a restarted Socket.IO server and updates connection state', async () => {
    const firstServer = await startMockServer();
    servers.push(firstServer);

    const client = await HappySessionClient.create(makeLegacyCredentials(), {
      serverUrl: firstServer.serverUrl,
      cwd: '/tmp/project',
    }, 'integration-tag', makeMetadata(), null);

    expect(client).toBeInstanceOf(HappySessionClient);
    if (!client) {
      throw new Error('Expected client to be created');
    }

    const states: ConnectionState[] = [];
    client.on('connectionState', state => {
      states.push(state);
    });

    await firstServer.whenConnected();
    await waitFor(() => {
      expect(client.getConnectionState()).toBe(ConnectionState.Connected);
    });

    await firstServer.close();
    servers.pop();

    await waitFor(() => {
      expect(client.getConnectionState()).toBe(ConnectionState.Disconnected);
    });

    const restartedServer = await startMockServer(new URL(firstServer.serverUrl).port ? Number(new URL(firstServer.serverUrl).port) : undefined);
    servers.push(restartedServer);

    await restartedServer.whenConnected();
    await waitFor(() => {
      expect(client.getConnectionState()).toBe(ConnectionState.Connected);
    }, 10_000);

    expect(states).toContain(ConnectionState.Disconnected);
    expect(states).toContain(ConnectionState.Connected);

    await client.close();
  });
});
