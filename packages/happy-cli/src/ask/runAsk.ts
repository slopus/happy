import { randomUUID } from 'node:crypto';

import type { SessionEnvelope, SessionTurnEndStatus } from '@slopus/happy-wire';

import { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import type { UserMessage } from '@/api/types';
import { AcpSessionManager } from '@/agent/acp/AcpSessionManager';
import { initialMachineMetadata } from '@/daemon/machineMetadata';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { encodeBase64 } from '@/api/encryption';
import type { Credentials } from '@/persistence';
import { readSettings } from '@/persistence';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import { logger } from '@/ui/logger';
import { connectionState } from '@/utils/serverConnectionErrors';
import {
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_FAST_MODEL,
  DEEPSEEK_PRO_MODEL,
  type DeepSeekChatMessage,
  type DeepSeekThinkingMode,
  streamDeepSeekChat,
} from '@/deepseek/deepseekClient';
import { resolveDeepSeekApiKey } from '@/deepseek/deepseekCredentials';
import { buildAskAugmentedUserContent } from './askTools';

type AskEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

type AskDeepSeekOptions = {
  model: string;
  baseUrl: string;
  thinking: DeepSeekThinkingMode;
  reasoningEffort?: 'high' | 'max';
  permissionMode: 'default';
  includePartialMessages: true;
  systemPrompt: string;
};

const DEFAULT_MAX_HISTORY_MESSAGES = 20;
const DEFAULT_SYSTEM_PROMPT = 'You are Happy Ask mode. Answer questions directly. Use the provided runtime or web context when relevant. Do not inspect local files, run commands, modify the user\'s machine, or claim access beyond the provided context.';

export function buildAskDeepSeekOptions(args: {
  model?: string | null;
  effort?: string | null;
  systemPrompt?: string;
}): AskDeepSeekOptions {
  const effort = normalizeEffort(args.effort);
  const model = normalizeAskDeepSeekModel(args.model);
  return {
    model,
    baseUrl: resolveAskDeepSeekBaseUrl(),
    thinking: resolveAskDeepSeekThinkingMode(model),
    ...(effort === 'high' || effort === 'max' ? { reasoningEffort: effort } : {}),
    permissionMode: 'default',
    includePartialMessages: true,
    systemPrompt: args.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
  };
}

export async function runAsk(opts: {
  credentials: Credentials;
  startedBy?: 'daemon' | 'terminal';
}): Promise<void> {
  const sessionTag = randomUUID();
  connectionState.setBackend('Ask');

  const api = await ApiClient.create(opts.credentials);
  const settings = await readSettings();
  const machineId = settings?.machineId;
  if (!machineId) {
    throw new Error('No machine ID found in settings');
  }

  await api.getOrCreateMachine({
    machineId,
    metadata: initialMachineMetadata,
  });

  const { state, metadata } = createSessionMetadata({
    flavor: 'ask',
    machineId,
    startedBy: opts.startedBy,
    sandbox: settings?.sandboxConfig,
  });
  const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });

  let session: ApiSessionClient;
  const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
    api,
    sessionTag,
    metadata,
    state,
    response,
    onSessionSwap: (newSession) => {
      session = newSession;
    },
  });
  session = initialSession;

  if (response) {
    await notifyDaemonSessionStarted(response.id, metadata, {
      encryptionKey: encodeBase64(response.encryptionKey),
      encryptionVariant: response.encryptionVariant,
      seq: response.seq,
      metadataVersion: response.metadataVersion,
      agentStateVersion: response.agentStateVersion,
    }).catch((error) => {
      logger.debug('[ask] Failed to report session to daemon:', error);
    });
  }

  const apiKey = resolveDeepSeekApiKey();
  const sessionManager = new AcpSessionManager();
  let activeAbortController: AbortController | null = null;
  let thinking = false;
  let stopped = false;
  let processing = false;
  const pendingMessages: UserMessage[] = [];
  const history: DeepSeekChatMessage[] = [{ role: 'system', content: DEFAULT_SYSTEM_PROMPT }];
  const maxHistoryMessages = resolveAskMaxHistoryMessages();

  const keepAliveTimer = setInterval(() => {
    session.keepAlive(thinking, 'remote');
  }, 5_000);

  const sendEnvelopes = (envelopes: SessionEnvelope[]) => {
    for (const envelope of envelopes) {
      session.sendSessionProtocolMessage(envelope);
    }
  };

  const ensureTurn = () => {
    sendEnvelopes(sessionManager.startTurn());
  };

  const sendText = (text: string, isThinking = false) => {
    if (!text) return;
    ensureTurn();
    sendEnvelopes(sessionManager.mapMessage(isThinking
      ? { type: 'event', name: 'thinking', payload: { text, streaming: true } }
      : { type: 'model-output', textDelta: text }));
  };

  const closeTurn = (status: SessionTurnEndStatus) => {
    sendEnvelopes(sessionManager.endTurn(status));
    thinking = false;
    session.keepAlive(false, 'remote');
    session.sendSessionEvent({ type: 'ready' });
  };

  const processMessage = async (message: UserMessage) => {
    const options = buildAskDeepSeekOptions({
      model: message.meta?.model,
      effort: message.meta?.effort,
      systemPrompt: message.meta?.customSystemPrompt ?? undefined,
    });

    if (!apiKey.key) {
      sendText('DeepSeek API key is not configured. Set HAPPY_DEEPSEEK_API_KEY or DEEPSEEK_API_KEY, or configure OpenCode deepseek auth.');
      closeTurn('failed');
      return;
    }

    if (history[0]?.role === 'system') {
      history[0] = { role: 'system', content: options.systemPrompt };
    }
    history.push({ role: 'user', content: await buildAskAugmentedUserContent(message.content.text) });
    trimAskHistory(history, maxHistoryMessages);

    activeAbortController = new AbortController();
    thinking = true;
    session.keepAlive(true, 'remote');
    ensureTurn();

    let assistantText = '';
    try {
      logger.debug('[ask] Starting DeepSeek request:', {
        model: options.model,
        baseUrl: options.baseUrl,
        thinking: options.thinking,
        apiKeySource: apiKey.source,
      });
      for await (const delta of streamDeepSeekChat({
        apiKey: apiKey.key,
        baseUrl: options.baseUrl,
        model: options.model,
        messages: history,
        thinking: options.thinking,
        reasoningEffort: options.reasoningEffort,
        signal: activeAbortController.signal,
      })) {
        if (delta.reasoningDelta) {
          sendText(delta.reasoningDelta, true);
        }
        if (delta.contentDelta) {
          assistantText += delta.contentDelta;
          sendText(delta.contentDelta);
        }
      }
      if (assistantText) {
        history.push({ role: 'assistant', content: assistantText });
        trimAskHistory(history, maxHistoryMessages);
      }
      closeTurn('completed');
    } catch (error) {
      logger.debug('[ask] DeepSeek query failed:', error);
      const aborted = activeAbortController.signal.aborted;
      sendText(aborted ? 'Cancelled.' : error instanceof Error ? error.message : String(error));
      closeTurn(aborted ? 'cancelled' : 'failed');
    } finally {
      activeAbortController = null;
      if (!stopped) {
        session.sendSessionEvent({ type: 'ready' });
      }
    }
  };

  const drainQueue = async () => {
    if (processing) return;
    processing = true;
    try {
      while (!stopped && pendingMessages.length > 0) {
        const message = pendingMessages.shift()!;
        await processMessage(message);
      }
    } finally {
      processing = false;
    }
  };

  const handleUserMessage = (message: UserMessage) => {
    if (stopped) return;
    pendingMessages.push(message);
    void drainQueue();
  };

  const stop = async (archiveReason = 'User terminated') => {
    if (stopped) return;
    stopped = true;
    clearInterval(keepAliveTimer);
    try {
      activeAbortController?.abort();
      closeTurn('cancelled');
      session.updateMetadata((currentMetadata) => ({
        ...currentMetadata,
        lifecycleState: 'archived',
        lifecycleStateSince: Date.now(),
        archivedBy: 'cli',
        archiveReason,
      }));
      session.sendSessionDeath();
      await session.flush();
      await session.close();
      reconnectionHandle?.cancel();
    } finally {
      process.exit(0);
    }
  };

  session.onUserMessage(handleUserMessage);
  session.on('archived', () => {
    void stop('Archived from app');
  });
  session.rpcHandlerManager.registerHandler('abort', async () => {
    activeAbortController?.abort();
  });
  registerKillSessionHandler(session.rpcHandlerManager, stop);

  session.sendSessionEvent({ type: 'ready' });

  await new Promise<void>(() => {
    // Keep the lightweight ask process alive until killed or archived.
  });
}

function normalizeEffort(effort: string | null | undefined): AskEffort | undefined {
  if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh' || effort === 'max') {
    return effort;
  }
  return undefined;
}

export function normalizeAskDeepSeekModel(model: string | null | undefined): string {
  const fallback = process.env.HAPPY_ASK_MODEL || process.env.HAPPY_DEEPSEEK_MODEL || process.env.DEEPSEEK_MODEL || DEEPSEEK_FAST_MODEL;
  if (!model || model === 'default') {
    return fallback;
  }
  if (model.startsWith('deepseek/')) {
    return model.slice('deepseek/'.length);
  }
  if (model.startsWith('deepseek-')) {
    return model;
  }
  return fallback;
}

export function resolveAskDeepSeekBaseUrl(): string {
  return process.env.HAPPY_ASK_BASE_URL
    || process.env.HAPPY_DEEPSEEK_BASE_URL
    || process.env.DEEPSEEK_BASE_URL
    || DEEPSEEK_DEFAULT_BASE_URL;
}

export function resolveAskDeepSeekThinkingMode(model: string): DeepSeekThinkingMode {
  const configured = process.env.HAPPY_ASK_THINKING || process.env.HAPPY_DEEPSEEK_THINKING || process.env.DEEPSEEK_THINKING;
  if (configured === 'enabled' || configured === 'disabled') {
    return configured;
  }
  return model === DEEPSEEK_PRO_MODEL ? 'enabled' : 'disabled';
}

export function resolveAskMaxHistoryMessages(): number {
  const raw = process.env.HAPPY_ASK_MAX_HISTORY_MESSAGES || process.env.HAPPY_DEEPSEEK_MAX_HISTORY_MESSAGES || process.env.DEEPSEEK_MAX_HISTORY_MESSAGES;
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_MAX_HISTORY_MESSAGES;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_HISTORY_MESSAGES;
}

export function trimAskHistory(history: DeepSeekChatMessage[], maxHistoryMessages: number): void {
  const maxLength = maxHistoryMessages + 1;
  if (history.length <= maxLength) {
    return;
  }
  history.splice(1, history.length - maxLength);
}
