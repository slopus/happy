import { createHash } from 'node:crypto';

import type { ApiSessionClient } from '@/api/apiSession';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { AcpReplayEvent } from './acpReplayCapture';
import { logger } from '@/ui/logger';

type TranscriptTextItem = { role: 'user' | 'agent'; text: string };

function normalizeTextForMatch(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
}

function fingerprintItem(item: TranscriptTextItem): string {
  return `${item.role}:${normalizeTextForMatch(item.text)}`;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function computeBestTailOverlap(existing: TranscriptTextItem[], replay: TranscriptTextItem[]): {
  ok: true;
  replayStartIndex: number;
  matchedCount: number;
} | {
  ok: false;
  reason: 'no_overlap' | 'ambiguous_overlap';
} {
  if (existing.length === 0) {
    return { ok: true, replayStartIndex: 0, matchedCount: 0 };
  }

  const existingFp = existing.map(fingerprintItem);
  const replayFp = replay.map(fingerprintItem);

  const maxK = Math.min(30, existingFp.length, replayFp.length);
  const minRequired = Math.min(3, existingFp.length);

  for (let k = maxK; k >= 1; k--) {
    const needle = existingFp.slice(-k);
    const matches: number[] = [];
    for (let i = 0; i <= replayFp.length - k; i++) {
      let ok = true;
      for (let j = 0; j < k; j++) {
        if (replayFp[i + j] !== needle[j]) {
          ok = false;
          break;
        }
      }
      if (ok) matches.push(i);
    }

    if (matches.length === 0) continue;
    if (matches.length > 1) {
      return { ok: false, reason: 'ambiguous_overlap' };
    }

    if (k < minRequired) {
      return { ok: false, reason: 'no_overlap' };
    }

    const startIndex = matches[0] + k;
    return { ok: true, replayStartIndex: startIndex, matchedCount: k };
  }

  return { ok: false, reason: 'no_overlap' };
}

function extractReplayTextItems(replay: AcpReplayEvent[]): {
  messages: TranscriptTextItem[];
  hasToolEvents: boolean;
} {
  const messages: TranscriptTextItem[] = [];
  let hasToolEvents = false;
  for (const event of replay) {
    if (event.type === 'message') {
      messages.push({ role: event.role, text: event.text });
    } else if (event.type === 'tool_call' || event.type === 'tool_result') {
      hasToolEvents = true;
    }
  }
  return { messages, hasToolEvents };
}

function makeImportLocalId(params: { provider: string; remoteSessionId: string; index: number; role: string; text: string }): string {
  const textHash = sha256(`${params.role}:${normalizeTextForMatch(params.text)}`).slice(0, 12);
  return `acp-import:v1:${params.provider}:${params.remoteSessionId}:${params.index}:${textHash}`;
}

function makeImportEventLocalId(params: { provider: string; remoteSessionId: string; index: number; key: string }): string {
  const short = sha256(params.key).slice(0, 12);
  return `acp-import:v1:${params.provider}:${params.remoteSessionId}:e${params.index}:${short}`;
}

export async function importAcpReplayHistoryV1(params: {
  session: ApiSessionClient;
  provider: 'gemini' | 'codex' | 'opencode';
  remoteSessionId: string;
  replay: AcpReplayEvent[];
  permissionHandler: AcpPermissionHandler;
}): Promise<void> {
  const { messages: replayMessages } = extractReplayTextItems(params.replay);
  if (replayMessages.length === 0) return;

  const existing = await params.session.fetchRecentTranscriptTextItemsForAcpImport({ take: 150 });
  const overlap = computeBestTailOverlap(existing, replayMessages);

  if (!overlap.ok) {
    // Divergence: prompt user, do nothing automatically.
    const remoteHash = sha256(replayMessages.map(fingerprintItem).join('|')).slice(0, 12);
    const permissionId = `AcpHistoryImport:v1:${params.provider}:${params.remoteSessionId}:${remoteHash}`;

    const localTail = existing.slice(-3).map((m) => ({ role: m.role, text: normalizeTextForMatch(m.text).slice(0, 200) }));
    const remoteTail = replayMessages.slice(-3).map((m) => ({ role: m.role, text: normalizeTextForMatch(m.text).slice(0, 200) }));

    logger.debug('[ACP History] Divergence detected; prompting user', {
      provider: params.provider,
      remoteSessionId: params.remoteSessionId,
      overlapReason: overlap.reason,
      localCount: existing.length,
      remoteCount: replayMessages.length,
    });

    // Use the standard permission flow so UI can render it as a tool card.
    const decisionPromise = params.permissionHandler.handleToolCall(permissionId, 'AcpHistoryImport', {
      provider: params.provider,
      remoteSessionId: params.remoteSessionId,
      localCount: existing.length,
      remoteCount: replayMessages.length,
      localTail,
      remoteTail,
      reason: overlap.reason,
      note: 'History differs from this session. Importing may duplicate messages.',
    });

    void decisionPromise.then(async (decision) => {
      if (decision.decision !== 'approved' && decision.decision !== 'approved_for_session' && decision.decision !== 'approved_execpolicy_amendment') {
        logger.debug('[ACP History] User skipped divergent history import', { provider: params.provider });
        return;
      }

      logger.debug('[ACP History] User approved divergent history import; importing full remote history', { provider: params.provider });
      await importFullReplay(params, params.replay);
    }).catch((error) => {
      logger.debug('[ACP History] Divergent history import prompt failed', { error });
    });

    return;
  }

  const startIndex = overlap.replayStartIndex;
  if (startIndex >= replayMessages.length) {
    return;
  }

  const newMessages = replayMessages.slice(startIndex);
  if (newMessages.length === 0) return;

  logger.debug('[ACP History] Importing new replay messages', {
    provider: params.provider,
    remoteSessionId: params.remoteSessionId,
    newCount: newMessages.length,
    matchedCount: overlap.matchedCount,
  });

  await importMessageDeltas(params, replayMessages, startIndex);
}

async function importMessageDeltas(
  params: {
    session: ApiSessionClient;
    provider: 'gemini' | 'codex' | 'opencode';
    remoteSessionId: string;
  },
  replayMessages: TranscriptTextItem[],
  startIndex: number,
): Promise<void> {
  for (let i = startIndex; i < replayMessages.length; i++) {
    const msg = replayMessages[i];
    const localId = makeImportLocalId({
      provider: params.provider,
      remoteSessionId: params.remoteSessionId,
      index: i,
      role: msg.role,
      text: msg.text,
    });

    if (msg.role === 'user') {
      params.session.sendUserTextMessage(msg.text, { localId, meta: { importedFrom: 'acp-history' } });
    } else {
      params.session.sendAgentMessage(
        params.provider,
        { type: 'message', message: msg.text },
        { localId, meta: { importedFrom: 'acp-history', remoteSessionId: params.remoteSessionId } },
      );
    }
  }

  // Best-effort metadata watermark; failure is non-fatal.
  try {
    const last = replayMessages[replayMessages.length - 1];
    params.session.updateMetadata((m: any) => ({
      ...m,
      acpHistoryImportV1: {
        v: 1,
        provider: params.provider,
        remoteSessionId: params.remoteSessionId,
        importedAt: Date.now(),
        lastImportedFingerprint: sha256(fingerprintItem(last)).slice(0, 16),
      },
    }));
  } catch (error) {
    logger.debug('[ACP History] Failed to update import watermark (non-fatal)', { error });
  }
}

async function importFullReplay(
  params: {
    session: ApiSessionClient;
    provider: 'gemini' | 'codex' | 'opencode';
    remoteSessionId: string;
  },
  replay: AcpReplayEvent[],
): Promise<void> {
  for (let i = 0; i < replay.length; i++) {
    const event = replay[i];
    if (event.type === 'message') {
      const localId = makeImportEventLocalId({
        provider: params.provider,
        remoteSessionId: params.remoteSessionId,
        index: i,
        key: `${event.role}:${event.text}`,
      });
      if (event.role === 'user') {
        params.session.sendUserTextMessage(event.text, { localId, meta: { importedFrom: 'acp-history' } });
      } else {
        params.session.sendAgentMessage(
          params.provider,
          { type: 'message', message: event.text },
          { localId, meta: { importedFrom: 'acp-history', remoteSessionId: params.remoteSessionId } },
        );
      }
      continue;
    }

    if (event.type === 'tool_call') {
      const localId = makeImportEventLocalId({
        provider: params.provider,
        remoteSessionId: params.remoteSessionId,
        index: i,
        key: `tool_call:${event.toolCallId}:${event.kind ?? ''}:${JSON.stringify(event.rawInput ?? null)}`,
      });
      params.session.sendAgentMessage(
        params.provider,
        {
          type: 'tool-call',
          callId: event.toolCallId,
          name: event.kind ?? event.title ?? 'tool',
          input: event.rawInput ?? {},
          id: `import-${event.toolCallId}`,
        },
        { localId, meta: { importedFrom: 'acp-history', remoteSessionId: params.remoteSessionId } },
      );
      continue;
    }

    if (event.type === 'tool_result') {
      const localId = makeImportEventLocalId({
        provider: params.provider,
        remoteSessionId: params.remoteSessionId,
        index: i,
        key: `tool_result:${event.toolCallId}:${event.status ?? ''}:${JSON.stringify(event.rawOutput ?? event.content ?? null)}`,
      });
      const isError = event.status === 'error' || event.status === 'failed';
      params.session.sendAgentMessage(
        params.provider,
        {
          type: 'tool-result',
          callId: event.toolCallId,
          output: event.rawOutput ?? event.content ?? null,
          id: `import-${event.toolCallId}-result`,
          isError,
        },
        { localId, meta: { importedFrom: 'acp-history', remoteSessionId: params.remoteSessionId } },
      );
    }
  }
}
