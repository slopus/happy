/**
 * HTTP control server for daemon management
 * Provides endpoints for listing sessions, stopping sessions, and daemon shutdown
 */

import fastify, { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { logger } from '@/ui/logger';
import { Metadata } from '@/api/types';
import { TrackedSession } from './types';

export function startDaemonControlServer({
  getChildren,
  stopSession,
  spawnSession,
  requestShutdown,
  onHappySessionWebhook
}: {
  getChildren: () => TrackedSession[];
  stopSession: (sessionId: string) => boolean;
  spawnSession: (directory: string, sessionId?: string) => TrackedSession | null;
  requestShutdown: () => void;
  onHappySessionWebhook: (sessionId: string, metadata: Metadata) => void;
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
          metadata: z.any() // Metadata type from API
        })
      }
    }, async (request, reply) => {
      const { sessionId, metadata } = request.body;
      
      logger.debug(`[CONTROL SERVER] Session started: ${sessionId}`);
      onHappySessionWebhook(sessionId, metadata);
      
      return { status: 'ok' };
    });

    // List all tracked sessions
    typed.post('/list', async (request, reply) => {
      const children = getChildren();
      logger.debug(`[CONTROL SERVER] Listing ${children.length} sessions`);
      return { children };
    });

    // Stop specific session
    typed.post('/stop-session', {
      schema: {
        body: z.object({
          sessionId: z.string()
        })
      }
    }, async (request, reply) => {
      const { sessionId } = request.body;
      
      logger.debug(`[CONTROL SERVER] Stop session request: ${sessionId}`);
      const success = stopSession(sessionId);
      return { success };
    });

    // Spawn new session
    typed.post('/spawn-session', {
      schema: {
        body: z.object({
          directory: z.string(),
          sessionId: z.string().optional()
        })
      }
    }, async (request, reply) => {
      const { directory, sessionId } = request.body;
      
      logger.debug(`[CONTROL SERVER] Spawn session request: dir=${directory}, sessionId=${sessionId || 'new'}`);
      const session = spawnSession(directory, sessionId);
      
      if (session) {
        return { success: true, pid: session.pid };
      } else {
        reply.code(500);
        return { error: 'Failed to spawn session' };
      }
    });

    // Stop daemon
    typed.post('/stop', async (request, reply) => {
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