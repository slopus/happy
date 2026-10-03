import { attachStandaloneDrain, type StandaloneDrain } from './standaloneDrain';
/**
 * HTTP control server for daemon management
 * Provides endpoints for listing sessions, stopping sessions, and daemon shutdown
 */

import fastify, { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { WebSocketServer } from 'ws';
import { logger } from '@/ui/logger';
import { Metadata } from '@/api/types';
import { decodeBase64, encodeBase64Url, getRandomBytes } from '@/api/encryption';
import { TrackedSession, SessionEncryptionData, SessionRuntimeState } from './types';
import type { StopSessionContext, StopSessionResult } from './sessionIdleReaper';
import { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import { PortRegistry } from './portRegistry';
import { proxyHttp, PreviewProxyError } from './previewProxy';
import { startServerProcess, StartServerError } from './startServer';
import { stopServerProcess, StopServerError } from './stopServer';
import { BrowserBridge, BridgeRequestError } from './browserBridge';
import { attachTerminalWsRoute, type MachineEncryption as TerminalMachineEncryption } from './controlServerTerminalWs';
import type { SessionWriteScopeRuntime } from './sessionWriteScopeRuntime';

/**
 * The only control-server paths a managed runtime may serve, and even these
 * are not open on the shared bearer alone.
 *
 * The bearer secret is loopback-wide: on a managed runtime the agent's own
 * tools can read it, so it proves "something on this host" and nothing about
 * *which* launch is reporting. A report accepted on that basis lets arbitrary
 * code forge another Run's session id. Each report is therefore additionally
 * checked against the launch registry by `verifyManagedReport`, and when no
 * verifier is wired — the current state, since T09 owns the launcher — the
 * path is refused rather than opened.
 *
 * `/stop` is deliberately absent: shutting the daemon down would also kill the
 * lease watchdog, and that authority does not belong with report authority.
 *
 * On a managed runtime these paths do **not** take the daemon-wide bearer at
 * all: the child never receives that secret, and requiring it would mean
 * handing it over. The per-launch capability is the only credential here.
 */
const MANAGED_REPORT_PATHS = new Set(['/session-started', '/session-runtime']);

/**
 * What a managed lifecycle report claims, taken from the parsed body.
 *
 * The verifier must see this, not just the path and headers: a launch token in
 * a header says which launch is speaking, while the body says which session is
 * being reported, and checking only the former lets launch A report a session
 * that belongs to B. The `kind` is passed so each report type can be validated
 * on its own terms rather than through one catch-all check.
 *
 * The whole parsed body travels with the claim because `sessionId` alone is not
 * the whole assertion. `metadata.hostPid` on a session-started report and
 * `hostPid` on a runtime report both steer which process the daemon adopts
 * (`run.ts` webhook and runtime handlers), so a registry that only saw the
 * session id could not tell a correct report from one that keeps the session
 * and swaps the process. Encryption scope is included for the same reason.
 */
export type ManagedReportClaim =
    | {
        kind: 'session-started';
        sessionId: string;
        headers: Record<string, unknown>;
        /** Whole parsed body. `metadata.hostPid` steers session adoption. */
        report: {
            sessionId: string;
            metadata: unknown;
            encryption?: {
                encryptionKey: string;
                encryptionVariant: 'legacy' | 'dataKey';
                seq: number;
                metadataVersion: number;
                agentStateVersion: number;
            };
        };
    }
    | {
        kind: 'session-runtime';
        sessionId: string;
        headers: Record<string, unknown>;
        /** Whole parsed body. `hostPid` adopts an untracked process. */
        report: Record<string, unknown>;
    };
import type { ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';

export function startDaemonControlServer({
  getChildren,
  stopSession,
  spawnSession,
  requestShutdown,
  onHappySessionWebhook,
  onHappySessionRuntime = () => {},
  portRegistry,
  browserBridge,
  allowedRoot = homedir(),
  getMachineEncryption = () => null,
  managedRuntime = false,
  verifyManagedReport,
  standaloneDrain,
  writeScopeRuntime,
}: {
  writeScopeRuntime?: SessionWriteScopeRuntime | null;
  standaloneDrain?: StandaloneDrain;
  getChildren: () => TrackedSession[];
  stopSession: (sessionId: string, context?: StopSessionContext) => StopSessionResult;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  requestShutdown: () => void;
  onHappySessionWebhook: (sessionId: string, metadata: Metadata, encryption?: SessionEncryptionData) => void;
  /** `reporter` carries facts about the process that sent the report (not about
   *  the conversation) — the daemon uses it to adopt sessions it isn't tracking. */
  onHappySessionRuntime?: (
    sessionId: string,
    runtime: Partial<SessionRuntimeState> & { updatedAt: number },
    reporter?: { hostPid?: number },
  ) => void;
  portRegistry: PortRegistry;
  browserBridge?: BrowserBridge;
  /** `/terminal` PTY cwd fallback boundary (decideTerminalCwd) — same value
   *  `spawnSession`'s own additionalDirectories handling already resolves.
   *  Defaults to homedir; only real callers that actually offer `/terminal`
   *  local-direct need to pass the caller's actual value. */
  allowedRoot?: string;
  /** Null until the daemon's machine registration resolves (it starts after
   *  this server does) — `/terminal` fails closed with a clean error until
   *  set. Defaults to an always-null getter (no local-direct support) so
   *  callers that don't wire this up (most tests, `preflightDaemonControlServer`)
   *  don't have to. */
  getMachineEncryption?: () => TerminalMachineEncryption | null;
  /** True on a verified managed runtime — closes the loopback spawn path. */
  managedRuntime?: boolean;
  /**
   * Checks a managed lifecycle report against the trusted launch registry.
   * Absent means no launcher is wired, and managed reports are then refused.
   */
  verifyManagedReport?: (input: ManagedReportClaim) =>
    Promise<{ ok: true } | { ok: false; reason: string }>;
}): Promise<{ port: number; stop: () => Promise<void>; controlSecret: string }> {
  return new Promise((resolve) => {
    const app = fastify({
      logger: false // We use our own logger
    });

    /**
     * Refuses a managed lifecycle report that no launch verifier vouched for.
     *
     * Returns a value when the request was refused so the route can `return` it;
     * `null` means the report may proceed. On a BYOS daemon this is inert.
     */
    const refuseUnverifiedManagedReport = async (
      claim: ManagedReportClaim,
    ): Promise<{ error: string; code: string } | null> => {
      if (writeScopeRuntime && !writeScopeRuntime.verifyReport(claim)) return {
        error: 'Protected session report rejected', code: 'SCOPE_REPORT_AUTH_REQUIRED',
      };
      if (!managedRuntime) return null;
      const verified = verifyManagedReport
        ? await verifyManagedReport(claim)
        : { ok: false as const, reason: 'no-launch-verifier' };
      if (verified.ok) return null;
      return {
        error: `managed report rejected (${verified.reason})`,
        code: 'MANAGED_LAUNCH_SCOPE_REQUIRED',
      };
    };

    // Loopback-only Bearer secret (ADR-061, specs/desktop-speed-breakthrough-
    // local-direct). This server binds 127.0.0.1 only, but loopback is shared
    // by every local user on the machine — without this, any other local
    // process could list/spawn/stop sessions or reach `/proxy-http`. Every
    // route requires it, with no legacy unauthenticated exceptions: the caller
    // persists this secret (daemon.state.json, 0600) and reads it back to
    // authenticate, so there is no bootstrap chicken-and-egg to work around.
    const controlSecret = encodeBase64Url(getRandomBytes(32));
    app.addHook('onRequest', async (request, reply) => {
      // On a managed runtime this loopback server is reachable by the agent's
      // own tools, so only the reports the daemon genuinely needs stay open.
      // Everything else here — spawn, stop, shell (`/start-server`), the HTTP
      // and browser proxies — would be an unsigned path to start or influence
      // work, which is what the managed dispatch RPCs exist to prevent.
      if (managedRuntime) {
        const path = new URL(request.url, 'http://127.0.0.1').pathname;
        if (!MANAGED_REPORT_PATHS.has(path)) {
          await reply.code(403).send({
            error: 'control endpoint is not available on a managed runtime',
            code: 'MANAGED_CAPABILITY_REQUIRED',
          });
          return;
        }
        // 보고 경로는 여기서 통과시키고, 각 라우트가 per-launch capability 로
        // 판정한다. daemon 전역 secret 을 요구하면 그 값을 child 에게 줘야 하고,
        // 그러면 agent 의 도구가 읽어 다른 Run 의 세션을 위조할 수 있다.
        // 통과가 곧 허용은 아니다 — verifier 가 없으면 라우트가 거부한다.
        return;
      }
      if (request.headers.authorization !== `Bearer ${controlSecret}`) {
        await reply.code(401).send({ error: 'unauthorized' });
        return;
      }
      if (standaloneDrain) {
        const path = new URL(request.url, 'http://127.0.0.1').pathname;
        const allowed = new Set(['/session-started', '/session-runtime', '/list', '/spawn-session', '/stop-session', '/stop',
          '/allocate-port', '/release-port', '/get-port', '/port-registry', '/standalone-drain/capabilities',
          '/standalone-drain/begin', '/standalone-drain/status', '/standalone-drain/commit', '/standalone-drain/terminate']);
        if (!allowed.has(path)) {
          await reply.code(403).send({ error: 'Endpoint unavailable in the standalone Windows Codex trial',
            code: 'STANDALONE_WINDOWS_TRIAL_UNSUPPORTED' });
        }
      }
    });

    // Same secret, same loopback trust boundary — but a WS upgrade never goes
    // through Fastify's route handlers/hooks above, so it needs its own check
    // at `verifyClient` (attachTerminalWsRoute).
    // The terminal WebSocket is a shell into the runtime and bypasses the RPC
    // dispatch gate entirely, so a managed runtime does not attach it at all.
    // The Windows standalone runtime does: every shell runs under its pty host
    // and is closed on drain (Desktop specs/windows-build-support W0-5h).
    const terminalWs = managedRuntime ? null : attachTerminalWsRoute(app.server, {
      path: '/terminal',
      controlSecret,
      allowedRoot,
      getMachineEncryption,
    });

    // Set up Zod type provider
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.post('/session-write-scope', { schema: { body: z.discriminatedUnion('action', [
      z.object({ action: z.literal('list'), sessionId: z.string().min(1).max(128) }).strict(),
      z.object({ action: z.literal('request'), sessionId: z.string().min(1).max(128), path: z.string().max(2048),
        description: z.string().max(240), kind: z.enum(['grant', 'revoke']).default('grant') }).strict(),
      z.object({ action: z.literal('cancel'), sessionId: z.string().min(1).max(128), requestId: z.string().uuid() }).strict(),
    ]) } }, async (request, reply) => {
      if (!writeScopeRuntime) return { supported: false, requests: [], reason: 'SESSION_WRITE_SCOPE_UNSUPPORTED' };
      try {
        const body = request.body;
        const broker = writeScopeRuntime.broker;
        const result = body.action === 'request' ? await broker.request(body.sessionId, body.path, body.description, body.kind)
          : body.action === 'cancel' ? await broker.cancel(body.sessionId, body.requestId) : undefined;
        return { supported: true, capabilities: writeScopeRuntime.capabilities, requests: writeScopeRuntime.list(body.sessionId), result };
      } catch (error) {
        return reply.code(409).send({ code: error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'WRITE_SCOPE_REQUEST_FAILED' });
      }
    });
    typed.post('/session-write-scope/decide', { schema: { body: z.object({
      decision: z.object({ version: z.literal(1), requestId: z.string().uuid(), digest: z.string().length(64),
        incarnation: z.string().max(128), accountId: z.string().max(128), machineId: z.string().max(128),
        sessionId: z.string().max(128), action: z.enum(['allow', 'project', 'cancel']) }).strict(),
      signature: z.string().max(128),
    }).strict() } }, async (request, reply) => {
      if (!writeScopeRuntime) return reply.code(409).send({ code: 'SESSION_WRITE_SCOPE_UNSUPPORTED' });
      try { return { result: await writeScopeRuntime.broker.decide(request.body) }; }
      catch { return reply.code(409).send({ code: 'WRITE_SCOPE_DECISION_REJECTED' }); }
    });
    typed.post('/session-write-scope/confirm', { schema: { body: z.object({
      token: z.string().uuid(), sessionId: z.string().max(128), digest: z.string().length(64), pid: z.number().int().positive(),
    }).strict() } }, async (request, reply) => {
      if (!writeScopeRuntime?.confirm(request.body)) return reply.code(403).send({ code: 'SCOPE_CONFIRMATION_REJECTED' });
      return { confirmed: true };
    });

    // Session reports itself after creation
    typed.post('/session-started', {
      schema: {
        body: z.object({
          sessionId: z.string(),
          metadata: z.any(),
          encryption: z.object({
            encryptionKey: z.string(),
            encryptionVariant: z.enum(['legacy', 'dataKey']),
            seq: z.number(),
            metadataVersion: z.number(),
            agentStateVersion: z.number(),
          }).optional()
        }),
        response: {
          200: z.object({
            status: z.literal('ok')
          }),
          403: z.object({
            error: z.string(),
            code: z.string(),
          })
        }
      }
    }, async (request, reply) => {
      const { sessionId, metadata, encryption } = request.body;

      // Checked after parsing so the claim carries the session the body names,
      // not just the launch the header names.
      const refusal = await refuseUnverifiedManagedReport({
        kind: 'session-started',
        sessionId,
        headers: request.headers as Record<string, unknown>,
        report: { sessionId, metadata, ...(encryption ? { encryption } : {}) },
      });
      if (refusal) {
        reply.code(403);
        return refusal;
      }

      logger.debug(`[CONTROL SERVER] Session started: ${sessionId}`);

      let encryptionData: SessionEncryptionData | undefined;
      if (encryption) {
        encryptionData = {
          encryptionKey: decodeBase64(encryption.encryptionKey),
          encryptionVariant: encryption.encryptionVariant,
          seq: encryption.seq,
          metadataVersion: encryption.metadataVersion,
          agentStateVersion: encryption.agentStateVersion,
        };
      }

      onHappySessionWebhook(sessionId, metadata, encryptionData);

      return { status: 'ok' as const };
    });

    typed.post('/session-runtime', {
      schema: {
        body: z.object({
          sessionId: z.string(),
          reportSeq: z.number().int().min(1).optional(),
          thinking: z.boolean().optional(),
          hasOpenToolCall: z.boolean().optional(),
          pendingUserInput: z.boolean().optional(),
          lastUserInteractionAt: z.number().optional(),
          /** A wall-clock ms timestamp. Fractions are refused at the door: a merged max would pin one forever. */
          lastTurnEndAt: z.number().int().min(0).optional(),
          assistantTurns: z.number().int().min(0).optional(),
          providerTokens: z.number().int().min(0).optional(),
          launchedBackgroundJob: z.boolean().optional(),
          /** Last message seq delivered to the agent loop. Absent on older CLIs. */
          lastProcessedSeq: z.number().optional(),
          mode: z.enum(['local', 'remote']).optional(),
          /** PID of the reporting session process. Absent on older CLIs. */
          hostPid: z.number().optional()
        }),
        response: {
          200: z.object({
            status: z.literal('ok')
          }),
          403: z.object({
            error: z.string(),
            code: z.string(),
          })
        }
      }
    }, async (request, reply) => {
      const { sessionId, reportSeq, thinking, hasOpenToolCall, pendingUserInput, lastUserInteractionAt, lastTurnEndAt, assistantTurns, providerTokens, launchedBackgroundJob, lastProcessedSeq, mode, hostPid } = request.body;

      const refusal = await refuseUnverifiedManagedReport({
        kind: 'session-runtime',
        sessionId,
        headers: request.headers as Record<string, unknown>,
        report: request.body as Record<string, unknown>,
      });
      if (refusal) {
        reply.code(403);
        return refusal;
      }

      onHappySessionRuntime(sessionId, {
        ...(reportSeq !== undefined ? { reportSeq } : {}),
        ...(thinking !== undefined ? { thinking } : {}),
        ...(hasOpenToolCall !== undefined ? { hasOpenToolCall } : {}),
        ...(pendingUserInput !== undefined ? { pendingUserInput } : {}),
        ...(lastUserInteractionAt !== undefined ? { lastUserInteractionAt } : {}),
        ...(lastTurnEndAt !== undefined ? { lastTurnEndAt } : {}),
        ...(assistantTurns !== undefined ? { assistantTurns } : {}),
        ...(providerTokens !== undefined ? { providerTokens } : {}),
        ...(launchedBackgroundJob !== undefined ? { launchedBackgroundJob } : {}),
        ...(lastProcessedSeq !== undefined ? { lastProcessedSeq } : {}),
        ...(mode !== undefined ? { mode } : {}),
        updatedAt: Date.now()
      }, hostPid !== undefined ? { hostPid } : undefined);

      return { status: 'ok' as const };
    });

    // List all tracked sessions
    typed.post('/list', {
      schema: {
        response: {
          200: z.object({
            children: z.array(z.object({
              startedBy: z.string(),
              happySessionId: z.string(),
              pid: z.number()
            }))
          })
        }
      }
    }, async () => {
      const children = getChildren();
      logger.debug(`[CONTROL SERVER] Listing ${children.length} sessions`);
      return { 
        children: children
          .filter(child => child.happySessionId !== undefined)
          .map(child => ({
            startedBy: child.startedBy,
            happySessionId: child.happySessionId!,
            pid: child.pid
          }))
      }
    });

    // Stop specific session
    typed.post('/stop-session', {
      schema: {
        body: z.object({
          sessionId: z.string(),
          source: z.string().optional(),
          reason: z.string().optional(),
          mode: z.enum(['force', 'if-idle']).optional()
        }),
        response: {
          // Mirrors the machine RPC stop-session contract: `stopped` plus a
          // structured refusal (`reason`/`guard`) so a policy-driven local
          // caller can tell "active refusal" from a real failure. `success`
          // stays for pre-v2 callers that only read that flag.
          200: z.object({
            success: z.boolean(),
            stopped: z.boolean(),
            reason: z.enum(['not-found', 'active', 'managed-generation', 'standalone-drain', 'standalone-unowned', 'standalone-blocked']).optional(),
            guard: z.string().optional(),
            detail: z.string().optional()
          })
        }
      }
    }, async (request) => {
      const { sessionId, source, reason, mode } = request.body;

      logger.debug(`[CONTROL SERVER] Stop session request: ${sessionId}`, { source, reason, mode });
      const result = stopSession(sessionId, {
        ...(source !== undefined ? { source } : {}),
        ...(reason !== undefined ? { reason } : {}),
        ...(mode !== undefined ? { mode } : {})
      });
      if (result.stopped) {
        return { success: true, stopped: true };
      }
      return {
        success: false,
        stopped: false,
        reason: result.reason,
        ...(result.reason === 'active' ? { guard: result.guard } : {}),
        ...('detail' in result ? { detail: result.detail } : {})
      };
    });

    // Spawn new session
    typed.post('/spawn-session', {
      schema: {
        body: z.object({
          directory: z.string(),
          sessionId: z.string().optional(),
          agent: z.enum(['claude', 'codex', 'gemini', 'grok', 'openclaw', 'opencode']).optional(),
          environmentVariables: z.record(z.string(), z.string()).optional(),
          happyToken: z.string().optional(),
          happySecret: z.string().optional(),
          axStep: z.enum(['plan', 'design', 'free']).optional(),
          bootstrapFiles: z.array(z.object({
            relativePath: z.string(),
            content: z.string(),
          })).optional(),
        }),
        response: {
          200: z.object({
            success: z.boolean(),
            sessionId: z.string().optional(),
            approvedNewDirectoryCreation: z.boolean().optional()
          }),
          409: z.object({
            success: z.boolean(),
            requiresUserApproval: z.boolean().optional(),
            actionRequired: z.string().optional(),
            directory: z.string().optional()
          }),
          500: z.object({
            success: z.boolean(),
            error: z.string().optional()
          })
        }
      }
    }, async (request, reply) => {
      const {
        directory,
        sessionId,
        agent,
        environmentVariables,
        happyToken,
        happySecret,
        axStep,
        bootstrapFiles,
      } = request.body;

      logger.debug(`[CONTROL SERVER] Spawn session request: dir=${directory}, sessionId=${sessionId || 'new'}, agent=${agent || 'default'}, hasUserCreds=${!!(happyToken && happySecret)}`);
      // The loopback control server is reachable by any code running inside the
      // runtime, including the agent's own tools. On a managed runtime that
      // would be an unsigned path to start work, so it is closed here.
      if (managedRuntime) {
        reply.code(500);
        return {
          success: false,
          error: 'spawn-session is not available on a managed runtime; use the managed dispatch RPCs',
        };
      }
      const result = await spawnSession({
        directory,
        sessionId,
        agent,
        environmentVariables,
        happyToken,
        happySecret,
        axStep,
        bootstrapFiles,
      });

      switch (result.type) {
        case 'success':
          // Check if sessionId exists, if not return error
          if (!result.sessionId) {
            reply.code(500);
            return {
              success: false,
              error: 'Failed to spawn session: no session ID returned'
            };
          }
          return {
            success: true,
            sessionId: result.sessionId,
            approvedNewDirectoryCreation: true
          };
        
        case 'requestToApproveDirectoryCreation':
          reply.code(409); // Conflict - user input needed
          return { 
            success: false,
            requiresUserApproval: true,
            actionRequired: 'CREATE_DIRECTORY',
            directory: result.directory
          };
        
        case 'error':
          reply.code(500);
          return { 
            success: false,
            error: result.errorMessage
          };
      }
    });

    // Allocate a port for a (user, project) — composite-keyed since
    // specs/preview-cross-user-isolation/ Phase 4. userId is required so
    // two users on the same machine cannot collide on a shared projectId
    // string.
    typed.post('/allocate-port', {
      schema: {
        body: z.object({
          userId: z.string().min(1),
          projectId: z.string().min(1)
        }),
        response: {
          200: z.object({
            port: z.number(),
            reused: z.boolean()
          }),
          503: z.object({
            error: z.string()
          })
        }
      }
    }, async (request, reply) => {
      const { userId, projectId } = request.body;
      try {
        const result = await portRegistry.allocate(userId, projectId);
        logger.debug(`[CONTROL SERVER] Allocated port ${result.port} for ${userId}:${projectId} (reused=${result.reused})`);
        return result;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        logger.debug(`[CONTROL SERVER] Port allocation failed for ${userId}:${projectId}: ${message}`);
        reply.code(503);
        return { error: message };
      }
    });

    // Release a (user, project) port binding (e.g., on project deletion)
    typed.post('/release-port', {
      schema: {
        body: z.object({
          userId: z.string().min(1),
          projectId: z.string().min(1)
        }),
        response: {
          200: z.object({
            released: z.boolean()
          })
        }
      }
    }, async (request) => {
      const { userId, projectId } = request.body;
      const released = await portRegistry.release(userId, projectId);
      logger.debug(`[CONTROL SERVER] Release port for ${userId}:${projectId}: released=${released}`);
      return { released };
    });

    // Look up the registered port for a single (user, project) without
    // allocating one. Used by web-ui preflight (specs/preview-server-
    // lifecycle/ Phase 1) to decide whether an existing server is
    // reusable before firing a new `startServerDirect` call. userId is
    // required (Phase 4) — the legacy bare-projectId entry is also
    // returned as a fallback so a daemon that has not yet seen the new
    // composite key still serves the right port for the original owner.
    typed.get('/get-port', {
      schema: {
        querystring: z.object({
          userId: z.string().min(1),
          projectId: z.string().min(1)
        }),
        response: {
          200: z.object({
            port: z.number().nullable()
          })
        }
      }
    }, async (request) => {
      const { userId, projectId } = request.query
      const data = await portRegistry.readAll()
      const entry = data[`${userId}:${projectId}`] ?? data[projectId]
      return { port: entry ? entry.port : null }
    });

    // Read full port registry (debugging / inspection)
    typed.get('/port-registry', {
      schema: {
        response: {
          200: z.object({
            entries: z.array(z.object({
              projectId: z.string(),
              port: z.number(),
              allocatedAt: z.number()
            }))
          })
        }
      }
    }, async () => {
      const data = await portRegistry.readAll();
      return {
        entries: Object.entries(data).map(([key, entry]) => ({
          projectId: entry.projectId ?? key,
          port: entry.port,
          allocatedAt: entry.allocatedAt
        }))
      };
    });

    // Spawn a dev server process on this machine on behalf of the web-ui
    // `/api/start-server` route. Lives next to /proxy-http because they
    // share the "remote-session management plane" — see
    // specs/remote-server-start/ Phase 3.
    const spawnedServers = new Map<number, ChildProcess>();
    typed.post('/start-server', {
      schema: {
        body: z.object({
          command: z.string().min(1),
          cwd: z.string().min(1),
          env: z.record(z.string(), z.string()).optional()
        }),
        response: {
          200: z.object({
            success: z.literal(true),
            pid: z.number()
          }),
          400: z.object({
            code: z.string(),
            error: z.string()
          }),
          500: z.object({
            code: z.string(),
            error: z.string()
          })
        }
      }
    }, async (request, reply) => {
      try {
        const result = await startServerProcess(request.body, {
          // Give Node's ChildProcess 'error' event (ENOENT) time to fire
          // before we claim success. Matches the web-ui handler's
          // setImmediate+error-once pattern.
          fastFailDelayMs: 50,
          onSpawn: (child) => {
            if (child.pid) {
              spawnedServers.set(child.pid, child);
              child.on('exit', () => spawnedServers.delete(child.pid!));
            }
          }
        });
        logger.debug(`[CONTROL SERVER] start-server spawned pid=${result.pid} cwd=${request.body.cwd}`);
        return { success: true as const, pid: result.pid };
      } catch (e) {
        if (e instanceof StartServerError) {
          logger.debug(`[CONTROL SERVER] start-server failed: ${e.code} ${e.message}`);
          if (e.code === 'CWD_NOT_FOUND' || e.code === 'INVALID_COMMAND') {
            reply.code(400);
          } else {
            reply.code(500);
          }
          return { code: e.code, error: e.message };
        }
        throw e;
      }
    });

    // Stop a dev server spawned via /start-server. Graceful SIGTERM with
    // SIGKILL fallback — see specs/preview-server-lifecycle/ Phase 5a.
    typed.post('/stop-server', {
      schema: {
        body: z.object({
          pid: z.number().int().positive()
        }),
        response: {
          200: z.object({
            stopped: z.literal(true),
            sentSignal: z.enum(['SIGTERM', 'SIGKILL'])
          }),
          400: z.object({
            code: z.string(),
            error: z.string()
          }),
          403: z.object({
            code: z.string(),
            error: z.string()
          }),
          404: z.object({
            code: z.string(),
            error: z.string()
          }),
          500: z.object({
            code: z.string(),
            error: z.string()
          }),
          504: z.object({
            code: z.string(),
            error: z.string()
          })
        }
      }
    }, async (request, reply) => {
      try {
        const result = await stopServerProcess({ pid: request.body.pid })
        logger.debug(`[CONTROL SERVER] stop-server pid=${request.body.pid} signal=${result.sentSignal}`)
        return { stopped: true as const, sentSignal: result.sentSignal }
      } catch (e) {
        if (e instanceof StopServerError) {
          logger.debug(`[CONTROL SERVER] stop-server failed: ${e.code} ${e.message}`)
          const status = (
            e.code === 'INVALID_PID' ? 400 :
            e.code === 'NO_SUCH_PROCESS' ? 404 :
            e.code === 'PERMISSION_DENIED' ? 403 :
            e.code === 'TIMEOUT' ? 504 :
            500
          )
          reply.code(status)
          return { code: e.code, error: e.message }
        }
        throw e
      }
    });

    // Relay an HTTP request to a local dev server on 127.0.0.1:{port}
    typed.post('/proxy-http', {
      schema: {
        body: z.object({
          port: z.number().int(),
          method: z.string().min(1),
          path: z.string().startsWith('/'),
          headers: z.record(z.string(), z.string()),
          bodyB64: z.string().nullable()
        }),
        response: {
          200: z.object({
            status: z.number(),
            headers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
            bodyB64: z.string(),
            truncated: z.boolean()
          }),
          400: z.object({
            code: z.string(),
            error: z.string()
          }),
          502: z.object({
            code: z.string(),
            error: z.string()
          }),
          504: z.object({
            code: z.string(),
            error: z.string()
          })
        }
      }
    }, async (request, reply) => {
      try {
        const result = await proxyHttp(request.body);
        logger.debug(`[CONTROL SERVER] proxy-http ${request.body.method} ${request.body.path} -> ${result.status}${result.truncated ? ' (truncated)' : ''}`);
        return result;
      } catch (e) {
        if (e instanceof PreviewProxyError) {
          logger.debug(`[CONTROL SERVER] proxy-http failed: ${e.code} ${e.message}`);
          if (e.code === 'INVALID_PORT' || e.code === 'INVALID_PATH') {
            reply.code(400);
          } else if (e.code === 'TIMEOUT') {
            reply.code(504);
          } else {
            reply.code(502);
          }
          return { code: e.code, error: e.message };
        }
        throw e;
      }
    });

    // Chrome extension bridge (specs/chrome-extension-bridge/). Sessions
    // reach the user's logged-in Chrome through these routes; the extension
    // itself connects to the dedicated WS listener (browserBridgeServer.ts)
    // which shares the same BrowserBridge instance.
    if (browserBridge) {
      typed.get('/browser/status', {
        schema: {
          querystring: z.object({
            viewerKey: z.string().regex(/^bv1_[A-Za-z0-9_-]{32}$/).optional()
          }),
          response: {
            200: z.object({
              connections: z.array(z.object({
                profile: z.string(),
                pairingId: z.string().optional(),
                viewerKey: z.string().optional(),
              })),
              hasRecentAuthFailure: z.boolean()
            })
          }
        }
      }, async (request) => {
        return {
          connections: browserBridge.connections(request.query.viewerKey),
          hasRecentAuthFailure: browserBridge.hasRecentAuthFailure(request.query.viewerKey)
        };
      });

      typed.post('/browser/request', {
        schema: {
          body: z.object({
            method: z.string().min(1),
            params: z.unknown().optional(),
            timeoutMs: z.number().int().positive().optional(),
            profile: z.string().optional(),
            viewerKey: z.string().regex(/^bv1_[A-Za-z0-9_-]{32}$/).optional()
          }),
          response: {
            200: z.object({
              result: z.unknown()
            }),
            502: z.object({
              code: z.string(),
              error: z.string()
            }),
            503: z.object({
              code: z.string(),
              error: z.string()
            }),
            504: z.object({
              code: z.string(),
              error: z.string()
            })
          }
        }
      }, async (request, reply) => {
        const { method, params, timeoutMs, profile, viewerKey } = request.body;
        try {
          const result = await browserBridge.request(method, params ?? {}, {
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            ...(profile !== undefined ? { profile } : {}),
            ...(viewerKey !== undefined ? { viewerKey } : {})
          });
          logger.debug(`[CONTROL SERVER] browser/request ${method} -> ok`);
          return { result };
        } catch (e) {
          if (e instanceof BridgeRequestError) {
            logger.debug(`[CONTROL SERVER] browser/request ${method} failed: ${e.code} ${e.message}`);
            reply.code(
              e.code === 'NO_EXTENSION_CONNECTED' ? 503 :
              e.code === 'TIMEOUT' ? 504 :
              502
            );
            return { code: e.code, error: e.message };
          }
          throw e;
        }
      });
    }

    attachStandaloneDrain(app, managedRuntime ? undefined : standaloneDrain, requestShutdown);

    // Stop daemon
    typed.post('/stop', {
      schema: {
        response: {
          200: z.object({ status: z.string() }),
          409: z.object({ status: z.string() })
        }
      }
    }, async (_request, reply) => {
      if (standaloneDrain) { reply.code(409); return { status: 'drain-required' }; }
      logger.debug('[CONTROL SERVER] Stop daemon request received');

      // Give time for response to arrive
      setTimeout(() => {
        logger.debug('[CONTROL SERVER] Triggering daemon shutdown');
        requestShutdown();
      }, 50);

      return { status: 'stopping' };
    });

    app.listen({ port: 0, host: '127.0.0.1' }, (err, address) => {
      if (err) {
        logger.debug('[CONTROL SERVER] Failed to start:', err);
        throw err;
      }

      const port = parseInt(address.split(':').pop()!);
      logger.debug(`[CONTROL SERVER] Started on port ${port}`);

      resolve({
        port,
        controlSecret,
        stop: async () => {
          logger.debug('[CONTROL SERVER] Stopping server');
          await terminalWs?.close();
          await app.close();
          logger.debug('[CONTROL SERVER] Server stopped');
        }
      });
    });
  });
}

export async function preflightDaemonControlServer(): Promise<void> {
  const portRegistry: PortRegistry = {
    allocate: async () => ({ port: 30000, reused: false }),
    release: async () => false,
    readAll: async () => ({}),
  }
  const server = await startDaemonControlServer({
    getChildren: () => [],
    stopSession: () => ({ stopped: false, reason: 'not-found' }),
    spawnSession: async () => ({ type: 'error', errorMessage: 'runtime preflight only' }),
    requestShutdown: () => {},
    onHappySessionWebhook: () => {},
    portRegistry,
  })
  await server.stop()
}
