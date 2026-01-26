import { logger } from '@/ui/logger';

import type { SpawnSessionOptions, SpawnSessionResult } from '../../modules/common/registerCommonHandlers';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';

export type MachineRpcHandlers = {
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  stopSession: (sessionId: string) => Promise<boolean>;
  requestShutdown: () => void;
};

export function registerMachineRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  handlers: MachineRpcHandlers;
}>): void {
  const { rpcHandlerManager, handlers } = params;
  const { spawnSession, stopSession, requestShutdown } = handlers;

  // Register spawn session handler
  rpcHandlerManager.registerHandler('spawn-happy-session', async (params: any) => {
    const {
      directory,
      sessionId,
      machineId,
      approvedNewDirectoryCreation,
      agent,
      token,
      environmentVariables,
      profileId,
      terminal,
      resume,
      permissionMode,
      permissionModeUpdatedAt,
      experimentalCodexResume,
      experimentalCodexAcp
    } = params || {};
    const envKeys = environmentVariables && typeof environmentVariables === 'object'
      ? Object.keys(environmentVariables as Record<string, unknown>)
      : [];
    const maxEnvKeysToLog = 20;
    const envKeySample = envKeys.slice(0, maxEnvKeysToLog);
    logger.debug('[API MACHINE] Spawning session', {
      directory,
      sessionId,
      machineId,
      agent,
      approvedNewDirectoryCreation,
      profileId,
      hasToken: !!token,
      terminal,
      permissionMode,
      permissionModeUpdatedAt: typeof permissionModeUpdatedAt === 'number' ? permissionModeUpdatedAt : undefined,
      environmentVariableCount: envKeys.length,
      environmentVariableKeySample: envKeySample,
      environmentVariableKeysTruncated: envKeys.length > maxEnvKeysToLog,
      hasResume: typeof resume === 'string' && resume.trim().length > 0,
      experimentalCodexResume: experimentalCodexResume === true,
      experimentalCodexAcp: experimentalCodexAcp === true,
    });

    // Handle resume-session type for inactive session resumption
    if (params?.type === 'resume-session') {
      const {
        sessionId: existingSessionId,
        directory,
        agent,
        resume,
        sessionEncryptionKeyBase64,
        sessionEncryptionVariant,
        experimentalCodexResume,
        experimentalCodexAcp
      } = params;
      logger.debug(`[API MACHINE] Resuming inactive session ${existingSessionId}`);

      if (!directory) {
        throw new Error('Directory is required');
      }
      if (!existingSessionId) {
        throw new Error('Session ID is required for resume');
      }
      if (!sessionEncryptionKeyBase64) {
        throw new Error('Session encryption key is required for resume');
      }
      if (sessionEncryptionVariant !== 'dataKey') {
        throw new Error('Unsupported session encryption variant for resume');
      }

      const result = await spawnSession({
        directory,
        agent,
        existingSessionId,
        approvedNewDirectoryCreation: true,
        resume: typeof resume === 'string' ? resume : undefined,
        sessionEncryptionKeyBase64,
        sessionEncryptionVariant,
        permissionMode,
        permissionModeUpdatedAt,
        experimentalCodexResume: Boolean(experimentalCodexResume),
        experimentalCodexAcp: Boolean(experimentalCodexAcp),
      });

      if (result.type === 'error') {
        throw new Error(result.errorMessage);
      }

      // For resume, we don't return a new session ID - we're reusing the existing one
      return { type: 'success' };
    }

    if (!directory) {
      throw new Error('Directory is required');
    }

    const result = await spawnSession({
      directory,
      sessionId,
      machineId,
      approvedNewDirectoryCreation,
      agent,
      token,
      environmentVariables,
      profileId,
      terminal,
      resume,
      permissionMode,
      permissionModeUpdatedAt,
      experimentalCodexResume,
      experimentalCodexAcp
    });

    switch (result.type) {
      case 'success':
        logger.debug(`[API MACHINE] Spawned session ${result.sessionId}`);
        return { type: 'success', sessionId: result.sessionId };

      case 'requestToApproveDirectoryCreation':
        logger.debug(`[API MACHINE] Requesting directory creation approval for: ${result.directory}`);
        return { type: 'requestToApproveDirectoryCreation', directory: result.directory };

      case 'error':
        throw new Error(result.errorMessage);
    }
  });

  // Register stop session handler
  rpcHandlerManager.registerHandler('stop-session', async (params: any) => {
    const { sessionId } = params || {};

    if (!sessionId) {
      throw new Error('Session ID is required');
    }

    const success = await stopSession(sessionId);
    if (!success) {
      throw new Error('Session not found or failed to stop');
    }

    logger.debug(`[API MACHINE] Stopped session ${sessionId}`);
    return { message: 'Session stopped' };
  });

  // Register stop daemon handler
  rpcHandlerManager.registerHandler('stop-daemon', () => {
    logger.debug('[API MACHINE] Received stop-daemon RPC request');

    // Trigger shutdown callback after a delay
    setTimeout(() => {
      logger.debug('[API MACHINE] Initiating daemon shutdown from RPC');
      requestShutdown();
    }, 100);

    return { message: 'Daemon stop request acknowledged, starting shutdown sequence...' };
  });
}

