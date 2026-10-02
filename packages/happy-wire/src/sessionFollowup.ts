import * as z from 'zod';
import type { AutomationCryptoAdapter } from './automation';
import {
  AUTHENTICATED_ENVELOPE_BYTES,
  AUTHENTICATED_ENVELOPE_VERSION,
  authenticatedEnvelopeBinding,
  openMachineDataKey,
  sealAuthenticatedEnvelope,
  type MachinePayloadOpening,
} from './authenticatedEnvelope';

export const SESSION_FOLLOWUP_WIRE_VERSION = 1;
export const SESSION_FOLLOWUP_MIN_ROUNDS = 2;
export const SESSION_FOLLOWUP_MAX_ROUNDS = 7;

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_CIPHERTEXT_BYTES = 128 * 1024;
const ENVELOPE_BYTES = 105;
const positiveInteger = z.number().int().min(1);
const timestamp = z.number().int().min(0);

function decodedBase64Length(value: string): number {
  return Math.floor(value.length * 3 / 4) - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
}

function firstBase64Byte(value: string): number {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  return (alphabet.indexOf(value[0]!) << 2) | (alphabet.indexOf(value[1]!) >> 4);
}

function base64Schema(maxBytes: number, options: { exactBytes?: number; minBytes?: number; version?: number } = {}) {
  return z.string().min(1).regex(BASE64_PATTERN).refine((value) => {
    const length = decodedBase64Length(value);
    return length <= maxBytes
      && length >= (options.minBytes ?? 0)
      && (options.exactBytes === undefined || length === options.exactBytes)
      && (options.version === undefined || firstBase64Byte(value) === options.version);
  }, 'invalid encoded value');
}

const payloadCiphertextSchema = base64Schema(MAX_CIPHERTEXT_BYTES, { minBytes: 41, version: 1 });
const envelopeSchema = base64Schema(ENVELOPE_BYTES, { exactBytes: ENVELOPE_BYTES, version: 1 });
/** The machine's copy may also be sender-authenticated (v3); a viewer's never is. */
const machineEnvelopeSchema = z.union([
  envelopeSchema,
  base64Schema(AUTHENTICATED_ENVELOPE_BYTES, { exactBytes: AUTHENTICATED_ENVELOPE_BYTES, version: AUTHENTICATED_ENVELOPE_VERSION }),
]);
const sessionCiphertextSchema = base64Schema(MAX_CIPHERTEXT_BYTES, { minBytes: 1 });

// The outer action is generic to an existing session. Evaluation policy is a
// versioned discriminator so future follow-up actions do not depend on Desktop
// component or IPC types.
/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary R12 — the session a
 * sender meant the prompt for. Inside the ciphertext, which a v3 machine
 * envelope binds; older daemons pass over it.
 */
export const sessionFollowupSealSchema = z.object({
  version: z.literal(1),
  machineId: z.string().min(1).max(200),
  projectId: z.string().min(1).max(200),
  sessionId: z.string().min(1).max(200),
  sealedAt: timestamp,
});
export type SessionFollowupSeal = z.infer<typeof sessionFollowupSealSchema>;

export const sessionFollowupPayloadSchema = z.object({
  kind: z.literal('existing-session-prompt'),
  directory: z.string().trim().min(1).max(1_000),
  prompt: z.string().trim().min(1).max(64_000),
  evaluator: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('review-findings-v1') }),
  ]),
  seal: sessionFollowupSealSchema.optional(),
});
export type SessionFollowupPayload = z.infer<typeof sessionFollowupPayloadSchema>;

export const sessionFollowupEncryptedFieldsSchema = z.object({
  payloadVersion: z.literal(1),
  payloadCiphertext: payloadCiphertextSchema,
  viewerKeyId: z.string().min(1).max(128),
  viewerKeyVersion: positiveInteger,
  viewerKeyEnvelope: envelopeSchema,
  machineKeyVersion: positiveInteger,
  machineKeyEnvelope: machineEnvelopeSchema,
});
export type SessionFollowupEncryptedFields = z.infer<typeof sessionFollowupEncryptedFieldsSchema>;

export const sessionFollowupCreateRequestSchema = sessionFollowupEncryptedFieldsSchema.extend({
  wireVersion: z.literal(SESSION_FOLLOWUP_WIRE_VERSION),
  sessionId: z.string().min(1).max(200),
  totalRounds: z.number().int().min(SESSION_FOLLOWUP_MIN_ROUNDS).max(SESSION_FOLLOWUP_MAX_ROUNDS),
  currentRound: positiveInteger,
  responseBoundarySeq: z.number().int().min(0),
}).superRefine((value, ctx) => {
  if (value.currentRound > value.totalRounds) {
    ctx.addIssue({ code: 'custom', path: ['currentRound'], message: 'currentRound exceeds totalRounds' });
  }
});
export type SessionFollowupCreateRequest = z.input<typeof sessionFollowupCreateRequestSchema>;

export const sessionFollowupStatusSchema = z.enum([
  'WAITING', 'DELIVERY_PENDING', 'PAUSED', 'COMPLETED', 'CANCELLED', 'FAILED',
]);
export type SessionFollowupStatus = z.infer<typeof sessionFollowupStatusSchema>;

export const sessionFollowupTerminalCodeSchema = z.enum([
  'CLEAN', 'LOW_OR_NIT_ONLY', 'UNSTRUCTURED', 'ROUNDS_EXHAUSTED',
  'USER_INTERVENTION', 'STOPPED', 'SESSION_UNAVAILABLE', 'TARGET_MISMATCH', 'DECRYPT_FAILED',
  'PERMISSION_REVOKED',
]);
export type SessionFollowupTerminalCode = z.infer<typeof sessionFollowupTerminalCodeSchema>;

export const sessionFollowupPublicSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  ownerAccountId: z.string().min(1),
  machineAccountId: z.string().min(1),
  machineId: z.string().min(1),
  sessionId: z.string().min(1),
  revision: positiveInteger,
  generation: positiveInteger,
  step: positiveInteger,
  status: sessionFollowupStatusSchema,
  terminalCode: sessionFollowupTerminalCodeSchema.nullable(),
  totalRounds: z.number().int().min(SESSION_FOLLOWUP_MIN_ROUNDS).max(SESSION_FOLLOWUP_MAX_ROUNDS),
  currentRound: positiveInteger,
  responseBoundarySeq: z.number().int().min(0),
  lastObservedSeq: z.number().int().min(0),
  payloadVersion: z.literal(1),
  payloadCiphertext: payloadCiphertextSchema,
  viewerKeyId: z.string().min(1).max(128),
  viewerKeyVersion: positiveInteger,
  viewerKeyEnvelope: envelopeSchema,
  machineKeyVersion: positiveInteger,
  completedAt: timestamp.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type SessionFollowupPublic = z.infer<typeof sessionFollowupPublicSchema>;

export const sessionFollowupHistorySchema = z.object({
  id: z.string().min(1),
  followupId: z.string().min(1),
  generation: positiveInteger,
  step: positiveInteger,
  round: positiveInteger,
  kind: z.enum([
    'STARTED', 'CONTINUATION_RESERVED', 'CONTINUATION_DELIVERED',
    'TERMINATED', 'PAUSED', 'RESUMED', 'STOPPED', 'DELETED',
  ]),
  terminalCode: sessionFollowupTerminalCodeSchema.nullable(),
  observedSeq: z.number().int().min(0).nullable(),
  detailCiphertext: sessionCiphertextSchema.nullable(),
  createdAt: timestamp,
});
export type SessionFollowupHistory = z.infer<typeof sessionFollowupHistorySchema>;

export const sessionFollowupRevisionRequestSchema = z.object({
  wireVersion: z.literal(SESSION_FOLLOWUP_WIRE_VERSION),
  expectedRevision: positiveInteger,
});
export type SessionFollowupRevisionRequest = z.infer<typeof sessionFollowupRevisionRequestSchema>;

export const sessionFollowupSyncRequestSchema = z.object({
  wireVersion: z.literal(SESSION_FOLLOWUP_WIRE_VERSION),
  afterSeq: z.string().regex(/^\d+$/),
  limit: z.number().int().min(1).max(500),
});

export const sessionFollowupDaemonSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  projectWorkspaceDir: z.string().min(1).max(1_000).nullable(),
  sessionId: z.string().min(1),
  machineAccountId: z.string().min(1),
  machineId: z.string().min(1),
  revision: positiveInteger,
  generation: positiveInteger,
  step: positiveInteger,
  status: z.enum(['WAITING', 'DELIVERY_PENDING']),
  totalRounds: z.number().int().min(2).max(7),
  currentRound: positiveInteger,
  responseBoundarySeq: z.number().int().min(0),
  lastObservedSeq: z.number().int().min(0),
  pendingExpectedSeq: z.number().int().min(0).nullable(),
  pendingLocalId: z.string().min(1).nullable(),
  payloadVersion: z.literal(1),
  payloadCiphertext: payloadCiphertextSchema,
  machineKeyVersion: positiveInteger,
  machineKeyEnvelope: machineEnvelopeSchema,
});
export type SessionFollowupDaemon = z.infer<typeof sessionFollowupDaemonSchema>;

export const sessionFollowupChangeSchema = z.discriminatedUnion('kind', [
  sessionFollowupDaemonSchema.extend({
    seq: z.string().regex(/^\d+$/),
    followupId: z.string().min(1),
    kind: z.literal('UPSERT'),
  }),
  z.object({
    seq: z.string().regex(/^\d+$/),
    followupId: z.string().min(1),
    revision: positiveInteger,
    generation: positiveInteger,
    kind: z.literal('TOMBSTONE'),
  }),
]);
export type SessionFollowupChange = z.infer<typeof sessionFollowupChangeSchema>;

export const sessionFollowupSyncResponseSchema = z.object({
  serverTime: timestamp,
  nextSeq: z.string().regex(/^\d+$/),
  hasMore: z.boolean(),
  changes: z.array(sessionFollowupChangeSchema),
});

export const sessionFollowupClaimRequestSchema = z.object({
  wireVersion: z.literal(SESSION_FOLLOWUP_WIRE_VERSION),
  followupId: z.string().min(1),
  generation: positiveInteger,
  step: positiveInteger,
});

export const sessionFollowupEvaluationTerminalCodeSchema = z.enum([
  'CLEAN', 'LOW_OR_NIT_ONLY', 'UNSTRUCTURED', 'ROUNDS_EXHAUSTED',
  'USER_INTERVENTION', 'SESSION_UNAVAILABLE', 'TARGET_MISMATCH', 'DECRYPT_FAILED',
  'PERMISSION_REVOKED',
]);
export type SessionFollowupEvaluationTerminalCode = z.infer<typeof sessionFollowupEvaluationTerminalCodeSchema>;

export const sessionFollowupEvaluationRequestSchema = z.object({
  wireVersion: z.literal(SESSION_FOLLOWUP_WIRE_VERSION),
  followupId: z.string().min(1),
  generation: positiveInteger,
  step: positiveInteger,
  claimToken: z.string().min(1).max(256),
  decision: z.enum(['WAIT', 'CONTINUE', 'TERMINATE']),
  observedSeq: z.number().int().min(0),
  // STOPPED belongs to the user control plane and must never be asserted by a
  // daemon evaluation report.
  terminalCode: sessionFollowupEvaluationTerminalCodeSchema.optional(),
}).superRefine((value, ctx) => {
  if ((value.decision === 'TERMINATE') !== (value.terminalCode !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['terminalCode'], message: 'terminalCode is required only for TERMINATE' });
  }
});
export type SessionFollowupEvaluationRequest = z.infer<typeof sessionFollowupEvaluationRequestSchema>;

export const sessionFollowupDeliverRequestSchema = z.object({
  wireVersion: z.literal(SESSION_FOLLOWUP_WIRE_VERSION),
  followupId: z.string().min(1),
  generation: positiveInteger,
  step: positiveInteger,
  claimToken: z.string().min(1).max(256),
  expectedSeq: z.number().int().min(0),
  localId: z.string().min(1).max(240),
  contentCiphertext: sessionCiphertextSchema,
});
export type SessionFollowupDeliverRequest = z.infer<typeof sessionFollowupDeliverRequestSchema>;

function versioned(value: Uint8Array): Uint8Array {
  const result = new Uint8Array(value.length + 1);
  result[0] = 1;
  result.set(value, 1);
  return result;
}

function openVersioned(value: string, crypto: AutomationCryptoAdapter, exactLength?: number): Uint8Array {
  const decoded = crypto.decodeBase64(value);
  if (decoded[0] !== 1 || (exactLength !== undefined && decoded.length !== exactLength)) {
    throw new Error('session-followup-decrypt-failed');
  }
  return decoded.slice(1);
}

/**
 * With `sender`, the machine's envelope is a v3 one sealed by that key
 * (aplus-dev-studio specs/e2ee-machine-control-boundary R12), and the payload
 * must carry the `seal` naming its session. Without it, both envelopes are
 * anonymous as before.
 */
export async function encryptSessionFollowupPayload(input: {
  payload: SessionFollowupPayload;
  viewer: { publicKey: Uint8Array; keyVersion: number };
  machine: { publicKey: Uint8Array; keyVersion: number };
  sender?: { publicKey: Uint8Array; secretKey: Uint8Array };
  crypto: AutomationCryptoAdapter;
}): Promise<SessionFollowupEncryptedFields> {
  const payload = sessionFollowupPayloadSchema.parse(input.payload);
  if (input.viewer.publicKey.length !== 32 || input.machine.publicKey.length !== 32
    || (input.sender && !payload.seal)) {
    throw new Error('session-followup-encrypt-failed');
  }
  const dek = input.crypto.randomBytes(32);
  if (dek.length !== 32) throw new Error('session-followup-encrypt-failed');
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = versioned(input.crypto.secretBoxSeal(plaintext, dek));
  let machineKeyEnvelope: Uint8Array;
  try {
    machineKeyEnvelope = input.sender
      ? sealAuthenticatedEnvelope({
        key: dek,
        binding: authenticatedEnvelopeBinding({ kind: 'session-followup', ciphertext }),
        recipientPublicKey: input.machine.publicKey,
        sender: input.sender,
      })
      : versioned(input.crypto.boxSeal(dek, input.machine.publicKey));
  } catch {
    throw new Error('session-followup-encrypt-failed');
  }
  return sessionFollowupEncryptedFieldsSchema.parse({
    payloadVersion: 1,
    payloadCiphertext: input.crypto.encodeBase64(ciphertext),
    viewerKeyId: input.crypto.encodeBase64(await input.crypto.sha256(input.viewer.publicKey), true),
    viewerKeyVersion: input.viewer.keyVersion,
    viewerKeyEnvelope: input.crypto.encodeBase64(versioned(input.crypto.boxSeal(dek, input.viewer.publicKey))),
    machineKeyVersion: input.machine.keyVersion,
    machineKeyEnvelope: input.crypto.encodeBase64(machineKeyEnvelope),
  });
}

/**
 * The daemon's side: opens the machine's copy, anonymous or v3, and says which.
 * Whether to trust the sender, and checking `seal` against the follow-up, is
 * the caller's.
 */
export async function openSessionFollowupPayloadForMachine(input: {
  payloadVersion: 1;
  payloadCiphertext: string;
  machineKeyEnvelope: string;
  recipientSecretKey: Uint8Array;
  crypto: AutomationCryptoAdapter;
}): Promise<MachinePayloadOpening<SessionFollowupPayload>> {
  let ciphertext: Uint8Array;
  let envelope: Uint8Array;
  try {
    if (input.payloadVersion !== 1 || input.recipientSecretKey.length !== 32) return { ok: false, reason: 'malformed' };
    ciphertext = input.crypto.decodeBase64(input.payloadCiphertext);
    envelope = input.crypto.decodeBase64(input.machineKeyEnvelope);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const opened = openMachineDataKey({
    kind: 'session-followup',
    envelope,
    ciphertext,
    recipientSecretKey: input.recipientSecretKey,
    openAnonymous: (bytes) => bytes.length === ENVELOPE_BYTES && bytes[0] === 1
      ? input.crypto.boxOpen(bytes.slice(1), input.recipientSecretKey)
      : null,
  });
  if (!opened.ok) return opened;
  try {
    if (ciphertext[0] !== 1) return { ok: false, reason: 'malformed' };
    const plaintext = input.crypto.secretBoxOpen(ciphertext.slice(1), opened.key);
    if (!plaintext) return { ok: false, reason: 'malformed' };
    const payload = sessionFollowupPayloadSchema.safeParse(JSON.parse(new TextDecoder().decode(plaintext)));
    if (!payload.success) return { ok: false, reason: 'malformed' };
    return { ok: true, payload: payload.data, authentication: opened.authentication };
  } catch {
    return { ok: false, reason: 'malformed' };
  } finally {
    opened.key.fill(0);
  }
}

export async function decryptSessionFollowupPayload(input: {
  payloadVersion: 1;
  payloadCiphertext: string;
  keyEnvelope: string;
  recipientSecretKey: Uint8Array;
  crypto: AutomationCryptoAdapter;
}): Promise<SessionFollowupPayload> {
  try {
    const encryptedDek = openVersioned(input.keyEnvelope, input.crypto, ENVELOPE_BYTES);
    const dek = input.crypto.boxOpen(encryptedDek, input.recipientSecretKey);
    if (!dek || dek.length !== 32) throw new Error();
    const encryptedPayload = openVersioned(input.payloadCiphertext, input.crypto);
    const plaintext = input.crypto.secretBoxOpen(encryptedPayload, dek);
    if (!plaintext) throw new Error();
    return sessionFollowupPayloadSchema.parse(JSON.parse(new TextDecoder().decode(plaintext)));
  } catch {
    throw new Error('session-followup-decrypt-failed');
  }
}

export class SessionFollowupApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly latest: SessionFollowupPublic | null = null) {
    super(code);
    this.name = 'SessionFollowupApiError';
  }
}

export type SessionFollowupFetch = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: string;
}) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface SessionFollowupApiClient {
  list(projectId: string, input?: { sessionId?: string; limit?: number }): Promise<SessionFollowupPublic[]>;
  get(projectId: string, followupId: string): Promise<SessionFollowupPublic>;
  start(projectId: string, input: SessionFollowupCreateRequest): Promise<SessionFollowupPublic>;
  pause(projectId: string, followupId: string, expectedRevision: number): Promise<SessionFollowupPublic>;
  resume(projectId: string, followupId: string, expectedRevision: number): Promise<SessionFollowupPublic>;
  stop(projectId: string, followupId: string, expectedRevision: number): Promise<SessionFollowupPublic>;
  delete(projectId: string, followupId: string, expectedRevision: number): Promise<SessionFollowupPublic>;
  history(projectId: string, followupId: string, limit?: number): Promise<SessionFollowupHistory[]>;
}

export function createSessionFollowupApiClient(options: {
  baseUrl: string;
  token: string;
  fetch: SessionFollowupFetch;
}): SessionFollowupApiClient {
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  const request = async <T>(path: string, schema: z.ZodType<T>, method = 'GET', body?: unknown): Promise<T> => {
    const response = await options.fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    if (!response.ok) {
      const row = data && typeof data === 'object' ? data as Record<string, unknown> : {};
      const latest = sessionFollowupPublicSchema.safeParse(row.latest);
      throw new SessionFollowupApiError(
        response.status,
        typeof row.error === 'string' ? row.error : 'session-followup-request-failed',
        latest.success ? latest.data : null,
      );
    }
    return schema.parse(data);
  };
  const root = (projectId: string) => `/v1/projects/${encodeURIComponent(projectId)}/session-followups`;
  const item = (projectId: string, followupId: string) => `${root(projectId)}/${encodeURIComponent(followupId)}`;
  const revision = (expectedRevision: number) => ({
    wireVersion: SESSION_FOLLOWUP_WIRE_VERSION as 1,
    expectedRevision,
  });
  return {
    list(projectId, input = {}) {
      const query = new URLSearchParams();
      if (input.sessionId) query.set('session_id', input.sessionId);
      if (input.limit !== undefined) query.set('limit', String(input.limit));
      const suffix = query.size > 0 ? `?${query}` : '';
      return request(`${root(projectId)}${suffix}`, z.array(sessionFollowupPublicSchema));
    },
    get(projectId, followupId) { return request(item(projectId, followupId), sessionFollowupPublicSchema); },
    start(projectId, input) {
      return request(root(projectId), sessionFollowupPublicSchema, 'POST', sessionFollowupCreateRequestSchema.parse(input));
    },
    pause(projectId, followupId, expectedRevision) {
      return request(`${item(projectId, followupId)}/pause`, sessionFollowupPublicSchema, 'POST', revision(expectedRevision));
    },
    resume(projectId, followupId, expectedRevision) {
      return request(`${item(projectId, followupId)}/resume`, sessionFollowupPublicSchema, 'POST', revision(expectedRevision));
    },
    stop(projectId, followupId, expectedRevision) {
      return request(`${item(projectId, followupId)}/stop`, sessionFollowupPublicSchema, 'POST', revision(expectedRevision));
    },
    delete(projectId, followupId, expectedRevision) {
      return request(item(projectId, followupId), sessionFollowupPublicSchema, 'DELETE', revision(expectedRevision));
    },
    history(projectId, followupId, limit) {
      const suffix = limit === undefined ? '' : `?limit=${encodeURIComponent(String(limit))}`;
      return request(`${item(projectId, followupId)}/history${suffix}`, z.array(sessionFollowupHistorySchema));
    },
  };
}
