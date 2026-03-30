import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { encodeBase64 } from 'happy-agent/encryption';
import { vi } from 'vitest';

import type {
  PiExtensionApiLike,
  PiHappyCommandOptions,
  PiHappyEventMap,
  PiHappyExtensionContext,
} from '../../extensions/types';

export type RegisteredHandlers = {
  [K in keyof PiHappyEventMap]?: (event: PiHappyEventMap[K], ctx: PiHappyExtensionContext) => void | Promise<void>;
};

export type SentUserMessageRecord = {
  content: string;
  options?: { deliverAs?: 'steer' | 'followUp' };
};

export type PiHarness = {
  pi: PiExtensionApiLike;
  ctx: PiHappyExtensionContext;
  handlers: RegisteredHandlers;
  commands: Map<string, PiHappyCommandOptions>;
  sentUserMessages: SentUserMessageRecord[];
  notifications: Array<{ message: string; level: 'info' | 'warning' | 'error' }>;
  statusHistory: Array<string | undefined>;
  widgetHistory: Array<string[] | undefined>;
  sendUserMessage: ReturnType<typeof vi.fn>;
  dispatch<K extends keyof PiHappyEventMap>(eventName: K, event: PiHappyEventMap[K]): Promise<void>;
  latestStatus(): string | undefined;
};

export type HappyHomeFixture = {
  rootDir: string;
  happyHomeDir: string;
  projectDir: string;
  cleanup: () => Promise<void>;
};

export type MockDaemonNotification = {
  sessionId: string;
  metadata: Record<string, unknown>;
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

export async function createHappyHomeFixture(options: {
  secret: Uint8Array;
  token: string;
  machineId?: string;
  daemonPort?: number;
  withCredentials?: boolean;
}): Promise<HappyHomeFixture> {
  const rootDir = await mkdtemp(join(tmpdir(), 'pi-happy-integration-'));
  const happyHomeDir = join(rootDir, '.happy');
  const projectDir = join(rootDir, 'project');

  await mkdir(happyHomeDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });

  if (options.withCredentials !== false) {
    await writeFile(join(happyHomeDir, 'access.key'), JSON.stringify({
      token: options.token,
      secret: encodeBase64(options.secret),
    }), 'utf8');
  }

  await writeFile(join(happyHomeDir, 'settings.json'), JSON.stringify({
    machineId: options.machineId ?? 'machine-integration-test',
  }), 'utf8');

  await writeFile(join(happyHomeDir, 'daemon.state.json'), JSON.stringify({
    httpPort: options.daemonPort,
  }), 'utf8');

  return {
    rootDir,
    happyHomeDir,
    projectDir,
    cleanup: async () => {
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

export function setHappyTestEnv(happyHomeDir: string, serverUrl: string): () => void {
  const previousServerUrl = process.env.HAPPY_SERVER_URL;
  const previousHomeDir = process.env.HAPPY_HOME_DIR;

  process.env.HAPPY_SERVER_URL = serverUrl;
  process.env.HAPPY_HOME_DIR = happyHomeDir;

  return () => {
    if (previousServerUrl === undefined) {
      delete process.env.HAPPY_SERVER_URL;
    } else {
      process.env.HAPPY_SERVER_URL = previousServerUrl;
    }

    if (previousHomeDir === undefined) {
      delete process.env.HAPPY_HOME_DIR;
    } else {
      process.env.HAPPY_HOME_DIR = previousHomeDir;
    }
  };
}

export function createPiHarness(overrides: Partial<PiHappyExtensionContext> = {}): PiHarness {
  const handlers: RegisteredHandlers = {};
  const commands = new Map<string, PiHappyCommandOptions>();
  const sentUserMessages: SentUserMessageRecord[] = [];
  const notifications: Array<{ message: string; level: 'info' | 'warning' | 'error' }> = [];
  const statusHistory: Array<string | undefined> = [];
  const widgetHistory: Array<string[] | undefined> = [];
  const flagValues: Record<string, unknown> = {};

  const sendUserMessage = vi.fn((content: string, options?: { deliverAs?: 'steer' | 'followUp' }) => {
    sentUserMessages.push({ content, options });
  });

  const ui = {
    setStatus: vi.fn((_key: string, value: string | undefined) => {
      statusHistory.push(value);
    }),
    setWidget: vi.fn((_key: string, value: string[] | undefined) => {
      widgetHistory.push(value);
    }),
    notify: vi.fn((message: string, level: 'info' | 'warning' | 'error') => {
      notifications.push({ message, level });
    }),
  };

  const ctx: PiHappyExtensionContext = {
    hasUI: true,
    ui,
    cwd: process.cwd(),
    model: { name: 'gpt-5' },
    isIdle: vi.fn(() => true),
    abort: vi.fn(),
    shutdown: vi.fn(),
    ...overrides,
  };

  const pi: PiExtensionApiLike = {
    on(eventName, handler) {
      handlers[eventName] = handler as never;
    },
    sendUserMessage,
    getAllTools() {
      return [
        { name: 'read' },
        { name: 'bash' },
      ];
    },
    getCommands() {
      return [
        { name: 'help' },
        { name: 'compact' },
      ];
    },
    registerFlag(name, options) {
      flagValues[name] = options.default;
    },
    getFlag(name) {
      return flagValues[name];
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
  };

  return {
    pi,
    ctx,
    handlers,
    commands,
    sentUserMessages,
    notifications,
    statusHistory,
    widgetHistory,
    sendUserMessage,
    async dispatch(eventName, event) {
      const handler = handlers[eventName];
      if (!handler) {
        throw new Error(`No handler registered for event ${String(eventName)}`);
      }
      await handler(event as never, ctx);
    },
    latestStatus() {
      return statusHistory.at(-1);
    },
  };
}

export class MockDaemonServer {
  private server: import('node:http').Server | null = null;
  private port: number | null = null;
  readonly notifications: MockDaemonNotification[] = [];

  get httpPort(): number {
    if (this.port === null) {
      throw new Error('MockDaemonServer has not been started yet');
    }
    return this.port;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    const { createServer } = await import('node:http');
    const { once } = await import('node:events');

    this.server = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/session-started') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }

        const raw = chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : '{}';
        const parsed = JSON.parse(raw) as MockDaemonNotification;
        this.notifications.push(parsed);

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.statusCode = 404;
      res.end('Not found');
    });

    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');

    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to determine daemon server port');
    }

    this.port = address.port;
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = null;
    this.port = null;

    await new Promise<void>(resolve => {
      server.close(() => resolve());
    });
  }
}
