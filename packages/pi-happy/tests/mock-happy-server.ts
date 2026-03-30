import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { SessionEnvelope } from '@slopus/happy-wire';
import { decodeBase64, decrypt, encodeBase64, encrypt } from 'happy-agent/encryption';
import { Server as SocketIoServer, type Socket as ServerSocket } from 'socket.io';

export type MockHappyServerConfig = {
  token: string;
  secret: Uint8Array;
  port?: number;
};

export type MockRpcRequestRecord = {
  method: string;
  params: unknown;
  response: unknown;
};

export type MockSessionAliveEvent = {
  sid: string;
  time: number;
  thinking: boolean;
  mode?: 'local' | 'remote';
};

export type MockSessionEndEvent = {
  sid: string;
  time: number;
};

export type MockMetadataUpdateRecord = {
  expectedVersion: number;
  metadata: Record<string, unknown>;
};

export type MockStateUpdateRecord = {
  expectedVersion: number;
  agentState: Record<string, unknown> | null;
};

export type MockStoredMessage = {
  id: string;
  seq: number;
  localId: string | null;
  content: {
    t: 'encrypted';
    c: string;
  };
  createdAt: number;
  updatedAt: number;
  decrypted: unknown;
  direction: 'client' | 'mobile';
};

export type MockSessionRecord = {
  id: string;
  tag: string;
  metadata: Record<string, unknown>;
  metadataVersion: number;
  agentState: Record<string, unknown> | null;
  agentStateVersion: number;
  createdAt: number;
  lastSeq: number;
  messages: MockStoredMessage[];
  rpcRegistrations: string[];
  rpcUnregistrations: string[];
  rpcRequests: MockRpcRequestRecord[];
  sessionAliveEvents: MockSessionAliveEvent[];
  sessionEndEvents: MockSessionEndEvent[];
  metadataUpdates: MockMetadataUpdateRecord[];
  stateUpdates: MockStateUpdateRecord[];
  socket: ServerSocket | null;
};

export type MockMessagePollRequest = {
  sessionId: string;
  afterSeq: number;
  limit: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number = 10_000,
  intervalMs: number = 20,
  errorMessage: string = 'Timed out waiting for condition',
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await sleep(intervalMs);
  }

  throw new Error(errorMessage);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return null;
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

type SessionProtocolMessage = {
  role: 'session';
  content: SessionEnvelope;
  meta?: Record<string, unknown>;
};

function isSessionProtocolMessage(value: unknown): value is SessionProtocolMessage {
  if (!isRecord(value) || value.role !== 'session') {
    return false;
  }

  const { content } = value;
  return isRecord(content) && isRecord(content.ev);
}

function toSessionEnvelope(value: unknown): SessionEnvelope | null {
  if (!isSessionProtocolMessage(value)) {
    return null;
  }
  return value.content;
}

export class MockHappyServer {
  private readonly token: string;
  private readonly secret: Uint8Array;
  private port: number | null;
  private httpServer: HttpServer | null = null;
  private ioServer: SocketIoServer | null = null;
  private readonly sessions = new Map<string, MockSessionRecord>();
  readonly createdSessions: MockSessionRecord[] = [];
  readonly messagePollRequests: MockMessagePollRequest[] = [];

  constructor(config: MockHappyServerConfig) {
    this.token = config.token;
    this.secret = config.secret;
    this.port = config.port ?? null;
  }

  get serverUrl(): string {
    if (this.port === null) {
      throw new Error('MockHappyServer has not been started yet');
    }
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    if (this.httpServer) {
      return;
    }

    const httpServer = createServer(async (req, res) => {
      try {
        await this.handleRequest(req, res);
      } catch (error) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          error: error instanceof Error ? error.message : 'Internal error',
        }));
      }
    });

    const ioServer = new SocketIoServer(httpServer, {
      path: '/v1/updates',
      transports: ['websocket'],
      cors: { origin: '*' },
    });

    ioServer.use((socket, next) => {
      const auth = socket.handshake.auth as {
        token?: string;
        clientType?: string;
        sessionId?: string;
      };

      if (auth.token !== this.token) {
        next(new Error('Unauthorized token'));
        return;
      }

      if (auth.clientType !== 'session-scoped') {
        next(new Error('Unsupported client type'));
        return;
      }

      if (!auth.sessionId || !this.sessions.has(auth.sessionId)) {
        next(new Error('Unknown session id'));
        return;
      }

      next();
    });

    ioServer.on('connection', socket => {
      const auth = socket.handshake.auth as { sessionId: string };
      const session = this.sessions.get(auth.sessionId);
      if (!session) {
        socket.disconnect(true);
        return;
      }

      session.socket = socket;

      socket.on('disconnect', () => {
        if (session.socket?.id === socket.id) {
          session.socket = null;
        }
      });

      socket.on('session-alive', data => {
        session.sessionAliveEvents.push(data);
      });

      socket.on('session-end', data => {
        session.sessionEndEvents.push(data);
      });

      socket.on('update-metadata', (data, callback) => {
        const decrypted = this.decryptPayload(data.metadata);
        const metadata = isRecord(decrypted) ? decrypted : {};
        session.metadata = metadata;
        session.metadataVersion += 1;
        session.metadataUpdates.push({
          expectedVersion: data.expectedVersion,
          metadata,
        });
        callback({
          result: 'success',
          version: session.metadataVersion,
          metadata: this.encryptPayload(session.metadata),
        });
      });

      socket.on('update-state', (data, callback) => {
        const decrypted = data.agentState ? this.decryptPayload(data.agentState) : null;
        const agentState = decrypted && isRecord(decrypted) ? decrypted : null;
        session.agentState = agentState;
        session.agentStateVersion += 1;
        session.stateUpdates.push({
          expectedVersion: data.expectedVersion,
          agentState,
        });
        callback({
          result: 'success',
          version: session.agentStateVersion,
          agentState: session.agentState ? this.encryptPayload(session.agentState) : null,
        });
      });

      socket.on('ping', callback => {
        callback();
      });

      socket.on('rpc-register', ({ method }) => {
        if (!session.rpcRegistrations.includes(method)) {
          session.rpcRegistrations.push(method);
        }
      });

      socket.on('rpc-unregister', ({ method }) => {
        session.rpcUnregistrations.push(method);
      });
    });

    httpServer.listen(this.port ?? 0, '127.0.0.1');
    await once(httpServer, 'listening');
    const address = httpServer.address() as AddressInfo | null;
    if (!address) {
      throw new Error('Failed to determine mock server address');
    }

    this.port = address.port;
    this.httpServer = httpServer;
    this.ioServer = ioServer;
  }

  async stop(): Promise<void> {
    if (!this.httpServer || !this.ioServer) {
      return;
    }

    const ioServer = this.ioServer;
    const httpServer = this.httpServer;
    this.ioServer = null;
    this.httpServer = null;

    for (const session of this.createdSessions) {
      session.socket = null;
    }

    await new Promise<void>(resolve => {
      ioServer.close(() => {
        httpServer.close(() => resolve());
      });
    });
  }

  async restart(): Promise<void> {
    const currentPort = this.port ?? undefined;
    await this.stop();
    this.port = currentPort ?? null;
    await this.start();
  }

  getLastSession(): MockSessionRecord {
    const last = this.createdSessions.at(-1);
    if (!last) {
      throw new Error('No sessions have been created');
    }
    return last;
  }

  getSession(sessionId: string): MockSessionRecord {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return session;
  }

  getSessionEnvelopes(sessionId: string): SessionEnvelope[] {
    return this.getSession(sessionId).messages
      .map(message => toSessionEnvelope(message.decrypted))
      .filter((value): value is SessionEnvelope => value !== null);
  }

  async waitForCreatedSessions(count: number, timeoutMs: number = 10_000): Promise<void> {
    await waitFor(
      () => this.createdSessions.length >= count,
      timeoutMs,
      20,
      `Expected at least ${count} created sessions`,
    );
  }

  async waitForSocketConnection(sessionId: string, timeoutMs: number = 10_000): Promise<void> {
    await waitFor(
      () => this.getSession(sessionId).socket !== null,
      timeoutMs,
      20,
      `Expected socket connection for session ${sessionId}`,
    );
  }

  async waitForRpcRegistration(sessionId: string, method: string, timeoutMs: number = 10_000): Promise<void> {
    const prefixedMethod = `${sessionId}:${method}`;
    await waitFor(
      () => this.getSession(sessionId).rpcRegistrations.includes(prefixedMethod),
      timeoutMs,
      20,
      `Expected RPC registration for ${prefixedMethod}`,
    );
  }

  queueIncomingUserMessage(sessionId: string, text: string): MockStoredMessage {
    return this.addStoredMessage(sessionId, {
      role: 'user',
      content: {
        type: 'text',
        text,
      },
    }, 'mobile');
  }

  emitIncomingUserMessage(sessionId: string, text: string): MockStoredMessage {
    const stored = this.queueIncomingUserMessage(sessionId, text);
    const session = this.getSession(sessionId);
    session.socket?.emit('update', {
      id: randomUUID(),
      seq: stored.seq,
      body: {
        t: 'new-message',
        sid: sessionId,
        message: this.publicMessage(stored),
      },
      createdAt: Date.now(),
    });
    return stored;
  }

  async callRpc(sessionId: string, method: string, params: unknown, timeoutMs: number = 10_000): Promise<unknown> {
    const session = this.getSession(sessionId);
    const socket = session.socket;
    if (!socket) {
      throw new Error(`Session ${sessionId} is not connected`);
    }

    const responseBase64 = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out waiting for rpc-request response: ${method}`));
      }, timeoutMs);

      socket.emit(
        'rpc-request',
        {
          method: `${sessionId}:${method}`,
          params: this.encryptPayload(params),
        },
        (response: string) => {
          clearTimeout(timeout);
          resolve(response);
        },
      );
    });

    const response = this.decryptPayload(responseBase64);
    session.rpcRequests.push({ method, params, response });
    return response;
  }

  private encryptPayload(payload: unknown): string {
    return encodeBase64(encrypt(this.secret, 'legacy', payload));
  }

  private decryptPayload(payloadBase64: string): unknown {
    return decrypt(this.secret, 'legacy', decodeBase64(payloadBase64));
  }

  private publicMessage(message: MockStoredMessage): Omit<MockStoredMessage, 'decrypted' | 'direction'> {
    return {
      id: message.id,
      seq: message.seq,
      localId: message.localId,
      content: message.content,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    };
  }

  private addStoredMessage(sessionId: string, payload: unknown, direction: 'client' | 'mobile'): MockStoredMessage {
    const session = this.getSession(sessionId);
    session.lastSeq += 1;
    const now = Date.now();
    const stored: MockStoredMessage = {
      id: `message-${session.lastSeq}`,
      seq: session.lastSeq,
      localId: direction === 'client' ? randomUUID() : null,
      content: {
        t: 'encrypted',
        c: this.encryptPayload(payload),
      },
      createdAt: now,
      updatedAt: now,
      decrypted: payload,
      direction,
    };
    session.messages.push(stored);
    return stored;
  }

  private assertAuth(req: IncomingMessage): void {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${this.token}`) {
      throw new Error('Unauthorized request');
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/v1/sessions') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        sessions: this.createdSessions.map(session => ({ id: session.id })),
      }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/sessions') {
      this.assertAuth(req);
      const body = await readJsonBody(req);
      const record = isRecord(body) ? body : {};
      const metadata = typeof record.metadata === 'string'
        ? this.decryptPayload(record.metadata)
        : {};
      const agentState = typeof record.agentState === 'string'
        ? this.decryptPayload(record.agentState)
        : null;
      const sessionId = `session-${this.createdSessions.length + 1}`;
      const session: MockSessionRecord = {
        id: sessionId,
        tag: typeof record.tag === 'string' ? record.tag : '',
        metadata: isRecord(metadata) ? metadata : {},
        metadataVersion: 1,
        agentState: agentState && isRecord(agentState) ? agentState : null,
        agentStateVersion: agentState ? 1 : 0,
        createdAt: Date.now(),
        lastSeq: 0,
        messages: [],
        rpcRegistrations: [],
        rpcUnregistrations: [],
        rpcRequests: [],
        sessionAliveEvents: [],
        sessionEndEvents: [],
        metadataUpdates: [],
        stateUpdates: [],
        socket: null,
      };
      this.sessions.set(sessionId, session);
      this.createdSessions.push(session);

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        session: {
          id: sessionId,
          seq: 1,
          metadata: this.encryptPayload(session.metadata),
          metadataVersion: session.metadataVersion,
          agentState: session.agentState ? this.encryptPayload(session.agentState) : null,
          agentStateVersion: session.agentStateVersion,
        },
      }));
      return;
    }

    const messagePathMatch = url.pathname.match(/^\/v3\/sessions\/([^/]+)\/messages$/);
    if (messagePathMatch) {
      this.assertAuth(req);
      const sessionId = decodeURIComponent(messagePathMatch[1] ?? '');
      const session = this.sessions.get(sessionId);
      if (!session) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Unknown session' }));
        return;
      }

      if (req.method === 'GET') {
        const afterSeq = Number(url.searchParams.get('after_seq') ?? '0') || 0;
        const limit = Number(url.searchParams.get('limit') ?? '100') || 100;
        this.messagePollRequests.push({ sessionId, afterSeq, limit });

        const matching = session.messages
          .filter(message => message.seq > afterSeq)
          .sort((a, b) => a.seq - b.seq);
        const messages = matching.slice(0, limit).map(message => this.publicMessage(message));

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          messages,
          hasMore: matching.length > messages.length,
        }));
        return;
      }

      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const record = isRecord(body) ? body : {};
        const messages = Array.isArray(record.messages) ? record.messages : [];
        const responseMessages = messages.map(message => {
          const parsed = isRecord(message) ? message : {};
          const contentBase64 = typeof parsed.content === 'string' ? parsed.content : '';
          const localId = typeof parsed.localId === 'string' ? parsed.localId : null;
          const decrypted = this.decryptPayload(contentBase64);
          const stored = this.addStoredMessage(sessionId, decrypted, 'client');
          stored.localId = localId;
          stored.content.c = contentBase64;
          return {
            id: stored.id,
            seq: stored.seq,
            localId: stored.localId,
            createdAt: stored.createdAt,
            updatedAt: stored.updatedAt,
          };
        });

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ messages: responseMessages }));
        return;
      }
    }

    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Not found' }));
  }
}
