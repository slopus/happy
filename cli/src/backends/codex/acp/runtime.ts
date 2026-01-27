import { randomUUID } from 'node:crypto';

import { logger } from '@/ui/logger';
import type { AgentBackend, AgentMessage, McpServerConfig } from '@/agent';
import { createCatalogAcpBackend } from '@/agent/acp';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import { maybeUpdateCodexSessionIdMetadata } from '@/backends/codex/utils/codexSessionIdMetadata';
import type { CodexAcpBackendOptions, CodexAcpBackendResult } from '@/backends/codex/acp/backend';
import {
  handleAcpModelOutputDelta,
  handleAcpStatusRunning,
  forwardAcpPermissionRequest,
  forwardAcpTerminalOutput,
} from '@/agent/acp/bridge/acpCommonHandlers';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { importAcpReplayHistoryV1 } from '@/agent/acp/history/importAcpReplayHistory';
import { normalizeAvailableCommands, publishSlashCommandsToMetadata } from '@/agent/acp/commands/publishSlashCommands';

export function createCodexAcpRuntime(params: {
  directory: string;
  session: ApiSessionClient;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  permissionHandler: AcpPermissionHandler;
  onThinkingChange: (thinking: boolean) => void;
}) {
  const lastCodexAcpThreadIdPublished: { value: string | null } = { value: null };

  let backend: AgentBackend | null = null;
  let sessionId: string | null = null;

  let accumulatedResponse = '';
  let isResponseInProgress = false;
  let taskStartedSent = false;
  let turnAborted = false;
  let loadingSession = false;

  const publishThreadIdToMetadata = () => {
    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => sessionId,
      updateHappySessionMetadata: (updater) => params.session.updateMetadata(updater),
      lastPublished: lastCodexAcpThreadIdPublished,
    });
  };

  const resetTurnState = () => {
    accumulatedResponse = '';
    isResponseInProgress = false;
    taskStartedSent = false;
    turnAborted = false;
    loadingSession = false;
  };

  const attachMessageHandler = (b: AgentBackend) => {
    b.onMessage((msg: AgentMessage) => {
      if (loadingSession) {
        if (msg.type === 'status' && msg.status === 'error') {
          turnAborted = true;
          params.session.sendAgentMessage('codex', { type: 'turn_aborted', id: randomUUID() });
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
              agent: 'codex',
              messageBuffer: params.messageBuffer,
              onThinkingChange: params.onThinkingChange,
              getTaskStartedSent: () => taskStartedSent,
              setTaskStartedSent: (value) => { taskStartedSent = value; },
              makeId: () => randomUUID(),
            });
          }

          if (msg.status === 'error') {
            turnAborted = true;
            params.session.sendAgentMessage('codex', { type: 'turn_aborted', id: randomUUID() });
          }
          break;
        }

        case 'tool-call': {
          params.messageBuffer.addMessage(`Executing: ${msg.toolName}`, 'tool');
          params.session.sendAgentMessage('codex', {
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
            const outputText = msg.result == null
              ? '(no output)'
              : typeof msg.result === 'string'
                ? msg.result
                : JSON.stringify(msg.result).slice(0, 200);
            params.messageBuffer.addMessage(`Result: ${outputText}`, 'result');
          }
          params.session.sendAgentMessage('codex', {
            type: 'tool-result',
            callId: msg.callId,
            output: msg.result,
            id: randomUUID(),
          });
          break;
        }

        case 'fs-edit': {
          params.messageBuffer.addMessage(`File edit: ${msg.description}`, 'tool');
          params.session.sendAgentMessage('codex', {
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
            agent: 'codex',
            getCallId: () => randomUUID(),
          });
          break;
        }

        case 'permission-request': {
          forwardAcpPermissionRequest({ msg, session: params.session, agent: 'codex' });
          break;
        }

        case 'event': {
          if ((msg as any).name === 'available_commands_update') {
            const payload = (msg as any).payload;
            const details = normalizeAvailableCommands(payload?.availableCommands ?? payload);
            publishSlashCommandsToMetadata({ session: params.session, details });
          }
          if ((msg as any).name === 'thinking') {
            const text = ((msg as any).payload?.text ?? '') as string;
            if (text) {
              params.session.sendAgentMessage('codex', { type: 'thinking', text });
            }
          }
          break;
        }
      }
    });
  };

  const ensureBackend = async (): Promise<AgentBackend> => {
    if (backend) return backend;
    const created = await createCatalogAcpBackend<CodexAcpBackendOptions, CodexAcpBackendResult>('codex', {
      cwd: params.directory,
      mcpServers: params.mcpServers,
      permissionHandler: params.permissionHandler,
    });
    backend = created.backend;
    attachMessageHandler(backend);
    logger.debug(`[CodexACP] Backend created (command=${created.command})`);
    return backend;
  };

  return {
    getSessionId: () => sessionId,

    beginTurn(): void {
      turnAborted = false;
    },

    async reset(): Promise<void> {
      sessionId = null;
      resetTurnState();

      if (backend) {
        try {
          await backend.dispose();
        } catch (e) {
          logger.debug('[CodexACP] Failed to dispose backend (non-fatal)', e);
        }
        backend = null;
      }
    },

    async startOrLoad(opts: { resumeId?: string | null }): Promise<string> {
      const b = await ensureBackend();

      if (opts.resumeId) {
        const resumeId = opts.resumeId.trim();
        const loadWithReplay = b.loadSessionWithReplayCapture;
        const loadSession = b.loadSession;
        if (!loadSession && !loadWithReplay) {
          throw new Error('Codex ACP backend does not support loading sessions');
        }
        loadingSession = true;
        let replay: any[] | null = null;
        try {
          if (loadWithReplay) {
            const loaded = await loadWithReplay(resumeId);
            sessionId = loaded.sessionId ?? resumeId;
            replay = Array.isArray(loaded.replay) ? (loaded.replay as any[]) : null;
          } else if (loadSession) {
            const loaded = await loadSession(resumeId);
            sessionId = loaded.sessionId ?? resumeId;
          } else {
            throw new Error('Codex ACP backend does not support loading sessions');
          }
        } finally {
          loadingSession = false;
        }

        if (replay) {
          importAcpReplayHistoryV1({
            session: params.session,
            provider: 'codex',
            remoteSessionId: resumeId,
            replay,
            permissionHandler: params.permissionHandler,
          }).catch((e) => {
            logger.debug('[CodexACP] Failed to import replay history (non-fatal)', e);
          });
        }
      } else {
        const started = await b.startSession();
        sessionId = started.sessionId;
      }

      publishThreadIdToMetadata();
      return sessionId;
    },

    async sendPrompt(prompt: string): Promise<void> {
      if (!sessionId) {
        throw new Error('Codex ACP session was not started');
      }
      const b = await ensureBackend();
      await b.sendPrompt(sessionId, prompt);
      if (b.waitForResponseComplete) {
        await b.waitForResponseComplete(120_000);
      }
      publishThreadIdToMetadata();
    },

    flushTurn(): void {
      if (accumulatedResponse.trim()) {
        params.session.sendAgentMessage('codex', { type: 'message', message: accumulatedResponse });
      }
      accumulatedResponse = '';
      isResponseInProgress = false;

      if (!turnAborted && taskStartedSent) {
        params.session.sendAgentMessage('codex', { type: 'task_complete', id: randomUUID() });
      }
      taskStartedSent = false;
      turnAborted = false;
    },
  };
}
