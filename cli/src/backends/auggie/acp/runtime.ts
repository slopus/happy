import { randomUUID } from 'node:crypto';

import { logger } from '@/ui/logger';
import type { AgentBackend, AgentMessage, McpServerConfig } from '@/agent';
import { createCatalogAcpBackend } from '@/agent/acp';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import {
  handleAcpModelOutputDelta,
  handleAcpStatusRunning,
  forwardAcpPermissionRequest,
  forwardAcpTerminalOutput,
} from '@/agent/acp/bridge/acpCommonHandlers';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { normalizeAvailableCommands, publishSlashCommandsToMetadata } from '@/agent/acp/commands/publishSlashCommands';
import { importAcpReplayHistoryV1 } from '@/agent/acp/history/importAcpReplayHistory';
import type { AuggieBackendOptions } from '@/backends/auggie/acp/backend';
import { maybeUpdateAuggieSessionIdMetadata } from '@/backends/auggie/utils/auggieSessionIdMetadata';

export function createAuggieAcpRuntime(params: {
  directory: string;
  session: ApiSessionClient;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  permissionHandler: AcpPermissionHandler;
  onThinkingChange: (thinking: boolean) => void;
  allowIndexing: boolean;
}) {
  const lastPublishedAuggieSessionId = { value: null as string | null };

  let backend: AgentBackend | null = null;
  let sessionId: string | null = null;

  let accumulatedResponse = '';
  let isResponseInProgress = false;
  let taskStartedSent = false;
  let turnAborted = false;
  let loadingSession = false;

  const resetTurnState = () => {
    accumulatedResponse = '';
    isResponseInProgress = false;
    taskStartedSent = false;
    turnAborted = false;
  };

  const publishSessionIdToMetadata = () => {
    maybeUpdateAuggieSessionIdMetadata({
      getAuggieSessionId: () => sessionId,
      updateHappySessionMetadata: (updater) => params.session.updateMetadata(updater),
      lastPublished: lastPublishedAuggieSessionId,
    });
  };

  const attachMessageHandler = (b: AgentBackend) => {
    b.onMessage((msg: AgentMessage) => {
      if (loadingSession) {
        if (msg.type === 'status' && msg.status === 'error') {
          turnAborted = true;
          params.session.sendAgentMessage('auggie', { type: 'turn_aborted', id: randomUUID() });
        }
        return;
      }

      switch (msg.type) {
        case 'model-output': {
          handleAcpModelOutputDelta({
            delta: msg.textDelta ?? '',
            messageBuffer: params.messageBuffer,
            getIsResponseInProgress: () => isResponseInProgress,
            setIsResponseInProgress: (value) => { isResponseInProgress = value; },
            appendToAccumulatedResponse: (delta) => { accumulatedResponse += delta; },
          });
          break;
        }

        case 'status': {
          if (msg.status === 'running') {
            handleAcpStatusRunning({
              session: params.session,
              agent: 'auggie',
              messageBuffer: params.messageBuffer,
              onThinkingChange: params.onThinkingChange,
              getTaskStartedSent: () => taskStartedSent,
              setTaskStartedSent: (value) => { taskStartedSent = value; },
              makeId: () => randomUUID(),
            });
          }

          if (msg.status === 'error') {
            turnAborted = true;
            params.session.sendAgentMessage('auggie', { type: 'turn_aborted', id: randomUUID() });
          }
          break;
        }

        case 'tool-call': {
          params.messageBuffer.addMessage(`Executing: ${msg.toolName}`, 'tool');
          params.session.sendAgentMessage('auggie', {
            type: 'tool-call',
            callId: msg.callId,
            name: msg.toolName,
            input: msg.args,
            id: randomUUID(),
          });
          break;
        }

        case 'tool-result': {
          const maybeStream =
            msg.result
            && typeof msg.result === 'object'
            && !Array.isArray(msg.result)
            && (typeof (msg.result as any).stdoutChunk === 'string' || (msg.result as any)._stream === true);
          if (!maybeStream) {
            const outputText = typeof msg.result === 'string'
              ? msg.result
              : JSON.stringify(msg.result ?? '').slice(0, 200);
            params.messageBuffer.addMessage(`Result: ${outputText}`, 'result');
          }
          params.session.sendAgentMessage('auggie', {
            type: 'tool-result',
            callId: msg.callId,
            output: msg.result,
            id: randomUUID(),
          });
          break;
        }

        case 'fs-edit': {
          params.messageBuffer.addMessage(`File edit: ${msg.description}`, 'tool');
          params.session.sendAgentMessage('auggie', {
            type: 'file-edit',
            description: msg.description,
            diff: msg.diff,
            filePath: msg.path || 'unknown',
            id: randomUUID(),
          });
          break;
        }

        case 'terminal-output': {
          forwardAcpTerminalOutput({
            msg,
            messageBuffer: params.messageBuffer,
            session: params.session,
            agent: 'auggie',
            getCallId: () => randomUUID(),
          });
          break;
        }

        case 'permission-request': {
          forwardAcpPermissionRequest({ msg, session: params.session, agent: 'auggie' });
          break;
        }

        case 'event': {
          const name = (msg as any).name as string | undefined;
          if (name === 'available_commands_update') {
            const payload = (msg as any).payload;
            const details = normalizeAvailableCommands(payload?.availableCommands ?? payload);
            publishSlashCommandsToMetadata({ session: params.session, details });
          }
          if (name === 'thinking') {
            const text = ((msg as any).payload?.text ?? '') as string;
            if (text) {
              params.session.sendAgentMessage('auggie', { type: 'thinking', text });
            }
          }
          break;
        }
      }
    });
  };

  const ensureBackend = async (): Promise<AgentBackend> => {
    if (backend) return backend;

    const created = await createCatalogAcpBackend<AuggieBackendOptions>('auggie', {
      cwd: params.directory,
      mcpServers: params.mcpServers,
      permissionHandler: params.permissionHandler,
      allowIndexing: params.allowIndexing,
    });

    backend = created.backend;
    attachMessageHandler(backend);
    logger.debug('[AuggieACP] Backend created');
    return backend;
  };

  return {
    getSessionId: () => sessionId,

    beginTurn(): void {
      turnAborted = false;
    },

    async cancel(): Promise<void> {
      if (!sessionId) return;
      const b = await ensureBackend();
      await b.cancel(sessionId);
    },

    async reset(): Promise<void> {
      sessionId = null;
      resetTurnState();
      loadingSession = false;

      if (backend) {
        try {
          await backend.dispose();
        } catch (e) {
          logger.debug('[AuggieACP] Failed to dispose backend (non-fatal)', e);
        }
        backend = null;
      }
    },

    async startOrLoad(opts: { resumeId?: string | null }): Promise<string> {
      const b = await ensureBackend();

      const resumeId = typeof opts.resumeId === 'string' ? opts.resumeId.trim() : '';
      if (resumeId) {
        const loadWithReplay = (b as any).loadSessionWithReplayCapture as ((id: string) => Promise<{ sessionId: string; replay?: unknown[] }>) | undefined;
        const loadSession = (b as any).loadSession as ((id: string) => Promise<{ sessionId: string }>) | undefined;
        if (!loadSession && !loadWithReplay) {
          throw new Error('Auggie ACP backend does not support loading sessions');
        }

        loadingSession = true;
        let replay: unknown[] | null = null;
        try {
          if (loadWithReplay) {
            const loaded = await loadWithReplay(resumeId);
            sessionId = loaded.sessionId ?? resumeId;
            replay = Array.isArray(loaded.replay) ? loaded.replay : null;
          } else {
            const loaded = await loadSession!(resumeId);
            sessionId = loaded.sessionId ?? resumeId;
          }
        } finally {
          loadingSession = false;
        }

        if (replay) {
          importAcpReplayHistoryV1({
            session: params.session,
            provider: 'auggie',
            remoteSessionId: resumeId,
            replay: replay as any[],
            permissionHandler: params.permissionHandler,
          }).catch((e) => {
            logger.debug('[AuggieACP] Failed to import replay history (non-fatal)', e);
          });
        }
      } else {
        const started = await b.startSession();
        sessionId = started.sessionId;
      }

      publishSessionIdToMetadata();
      return sessionId!;
    },

    async sendPrompt(prompt: string): Promise<void> {
      if (!sessionId) {
        throw new Error('Auggie ACP session was not started');
      }

      const b = await ensureBackend();
      await b.sendPrompt(sessionId, prompt);
      if (b.waitForResponseComplete) {
        await b.waitForResponseComplete(120_000);
      }
      publishSessionIdToMetadata();
    },

    flushTurn(): void {
      if (accumulatedResponse.trim()) {
        params.session.sendAgentMessage('auggie', { type: 'message', message: accumulatedResponse });
      }

      if (!turnAborted) {
        params.session.sendAgentMessage('auggie', { type: 'task_complete', id: randomUUID() });
      }

      resetTurnState();
    },
  };
}

