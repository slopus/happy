/**
 * HTTP control server for daemon management
 * Provides endpoints for listing sessions, stopping sessions, and daemon shutdown
 */

import fastify, { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { logger } from '@/ui/logger';
import { Metadata } from '@/api/types';
import { decodeBase64 } from '@/api/encryption';
import { TrackedSession, SessionEncryptionData, SessionRuntimeState } from './types';
import type { StopSessionContext, StopSessionResult } from './sessionIdleReaper';
import { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import { PortRegistry } from './portRegistry';
import { proxyHttp, PreviewProxyError } from './previewProxy';
import { startServerProcess, StartServerError } from './startServer';
import { stopServerProcess, StopServerError } from './stopServer';
import type { ChildProcess } from 'node:child_process';

export function startDaemonControlServer({
  getChildren,
  stopSession,
  spawnSession,
  requestShutdown,
  onHappySessionWebhook,
  onHappySessionRuntime = () => {},
  portRegistry
}: {
  getChildren: () => TrackedSession[];
  stopSession: (sessionId: string, context?: StopSessionContext) => StopSessionResult;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  requestShutdown: () => void;
  onHappySessionWebhook: (sessionId: string, metadata: Metadata, encryption?: SessionEncryptionData) => void;
  onHappySessionRuntime?: (sessionId: string, runtime: Partial<SessionRuntimeState> & { updatedAt: number }) => void;
  portRegistry: PortRegistry;
}): Promise<{ port: number; stop: () => Promise<void> }> {
  return new Promise((resolve) => {
    const app = fastify({
      logger: false // We use our own logger
    });

    // Set up Zod type provider
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>();

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
          })
        }
      }
    }, async (request) => {
      const { sessionId, metadata, encryption } = request.body;

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
          thinking: z.boolean().optional(),
          hasOpenToolCall: z.boolean().optional(),
          pendingUserInput: z.boolean().optional(),
          lastUserInteractionAt: z.number().optional(),
          mode: z.enum(['local', 'remote']).optional()
        }),
        response: {
          200: z.object({
            status: z.literal('ok')
          })
        }
      }
    }, async (request) => {
      const { sessionId, thinking, hasOpenToolCall, pendingUserInput, lastUserInteractionAt, mode } = request.body;

      onHappySessionRuntime(sessionId, {
        ...(thinking !== undefined ? { thinking } : {}),
        ...(hasOpenToolCall !== undefined ? { hasOpenToolCall } : {}),
        ...(pendingUserInput !== undefined ? { pendingUserInput } : {}),
        ...(lastUserInteractionAt !== undefined ? { lastUserInteractionAt } : {}),
        ...(mode !== undefined ? { mode } : {}),
        updatedAt: Date.now()
      });

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
            reason: z.enum(['not-found', 'active']).optional(),
            guard: z.string().optional()
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
        ...(result.reason === 'active' ? { guard: result.guard } : {})
      };
    });

    // Spawn new session
    typed.post('/spawn-session', {
      schema: {
        body: z.object({
          directory: z.string(),
          sessionId: z.string().optional(),
          agent: z.enum(['claude', 'codex', 'gemini', 'openclaw', 'opencode']).optional(),
          environmentVariables: z.record(z.string(), z.string()).optional(),
          happyToken: z.string().optional(),
          happySecret: z.string().optional(),
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
      const { directory, sessionId, agent, environmentVariables, happyToken, happySecret } = request.body;

      logger.debug(`[CONTROL SERVER] Spawn session request: dir=${directory}, sessionId=${sessionId || 'new'}, agent=${agent || 'default'}, hasUserCreds=${!!(happyToken && happySecret)}`);
      const result = await spawnSession({ directory, sessionId, agent, environmentVariables, happyToken, happySecret });

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
            headers: z.record(z.string(), z.string()),
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

    // Stop daemon
    typed.post('/stop', {
      schema: {
        response: {
          200: z.object({
            status: z.string()
          })
        }
      }
    }, async () => {
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
        stop: async () => {
          logger.debug('[CONTROL SERVER] Stopping server');
          await app.close();
          logger.debug('[CONTROL SERVER] Server stopped');
        }
      });
    });
  });
}
