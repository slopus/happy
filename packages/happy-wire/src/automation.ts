import * as z from 'zod';
import {
  AUTHENTICATED_ENVELOPE_BYTES,
  AUTHENTICATED_ENVELOPE_VERSION,
  authenticatedEnvelopeBinding,
  openMachineDataKey,
  sealAuthenticatedEnvelope,
  type MachinePayloadOpening,
} from './authenticatedEnvelope';

export const AUTOMATION_RUN_NOW_PROTOCOL_VERSION = 2;
export const AUTOMATION_ISSUE_TRIGGER_PROTOCOL_VERSION = 3;
export const AUTOMATION_SESSION_FOLLOWUP_PROTOCOL_VERSION = 4;
export const AUTOMATION_PROTOCOL_VERSION = AUTOMATION_SESSION_FOLLOWUP_PROTOCOL_VERSION;

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PAYLOAD_MAX_BYTES = 128 * 1024;
const ENVELOPE_BYTES = 105;

function decodedBase64Length(value: string): number {
  return Math.floor(value.length * 3 / 4) - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
}

function firstBase64Byte(value: string): number {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  return (alphabet.indexOf(value[0]!) << 2) | (alphabet.indexOf(value[1]!) >> 4);
}

function base64Schema(maxBytes: number, options: { minBytes?: number; exactBytes?: number; version?: number } = {}) {
  return z.string().min(1).regex(BASE64_PATTERN).refine(
    (value) => {
      const length = decodedBase64Length(value);
      return length <= maxBytes
        && length >= (options.minBytes ?? 0)
        && (options.exactBytes === undefined || length === options.exactBytes)
        && (options.version === undefined || firstBase64Byte(value) === options.version);
    },
    'invalid encoded value',
  );
}

const positiveInteger = z.number().int().min(1);
const timestamp = z.number().int().min(0);
const publicKeySchema = base64Schema(32, { exactBytes: 32 });
const payloadCiphertextSchema = base64Schema(PAYLOAD_MAX_BYTES, { minBytes: 41, version: 1 });
const envelopeSchema = base64Schema(ENVELOPE_BYTES, { exactBytes: ENVELOPE_BYTES, version: 1 });
/** The machine's copy may also be sender-authenticated (v3); a viewer's never is. */
const machineEnvelopeSchema = z.union([
  envelopeSchema,
  base64Schema(AUTHENTICATED_ENVELOPE_BYTES, { exactBytes: AUTHENTICATED_ENVELOPE_BYTES, version: AUTHENTICATED_ENVELOPE_VERSION }),
]);

export const automationAgentSchema = z.enum(['claude', 'codex', 'gemini', 'openclaw', 'opencode']);
export type AutomationAgent = z.infer<typeof automationAgentSchema>;

export const automationScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('interval'), minutes: z.number().int().min(15) }),
  // A distinct discriminator makes older daemons reject GitHub triggers instead
  // of stripping githubTrigger and running them as ordinary scheduled prompts.
  z.object({ kind: z.literal('github'), minutes: z.literal(15) }),
  z.object({
    kind: z.literal('daily'),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
]);
export type AutomationSchedule = z.infer<typeof automationScheduleSchema>;

export const githubTriggerEventSchema = z.enum(['opened', 'ready_for_review', 'merged', 'closed', 'issue_opened']);
export type GithubTriggerEvent = z.infer<typeof githubTriggerEventSchema>;

export const githubTriggerSchema = z.object({
  event: githubTriggerEventSchema,
  filter: z.object({
    baseBranch: z.string().trim().min(1).max(255).nullable(),
    label: z.string().trim().min(1).max(100).nullable(),
    excludeDraft: z.boolean(),
    authors: z.array(z.string().trim().min(1).max(100)).max(100),
    paths: z.array(z.string().trim().min(1).max(1_000)).max(100),
  }),
  action: z.enum(['notify', 'start-session', 'agent-task-review']),
  githubCredentialId: z.string().trim().min(1).max(200).nullable(),
  // high 발견이 있을 때 AgentTask 리뷰 코멘트에서 소환할 GitHub 핸들. 코멘트를
  // 조립하는 건 서버라 워커 프롬프트로는 전달할 수 없다 — 설정이 유일한 통로다.
  // 값의 형식(핸들 모양)은 코멘트를 만드는 쪽에서 다시 검증한다.
  escalateTo: z.array(z.string().trim().min(1).max(64)).max(10).optional(),
}).superRefine((trigger, context) => {
  if (trigger.action === 'agent-task-review' && trigger.githubCredentialId === null) {
    context.addIssue({
      code: 'custom',
      path: ['githubCredentialId'],
      message: 'AgentTask review requires an explicit GitHub credential',
    });
  }
});
export type GithubTrigger = z.infer<typeof githubTriggerSchema>;

/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary R12 — what a sender
 * vouches for besides the content. It travels inside the ciphertext, which a
 * v3 machine envelope binds, so it is as authentic as the envelope; older
 * daemons and every viewer pass over it.
 */
export const automationSealSchema = z.object({
  version: z.literal(1),
  machineId: z.string().min(1).max(200),
  projectId: z.string().min(1).max(200),
  /** Chosen by the client at creation and kept across edits: the server id does not exist yet when it is first sealed. */
  automationKey: z.string().min(16).max(128),
  sealedAt: timestamp,
});
export type AutomationSeal = z.infer<typeof automationSealSchema>;

export const automationPayloadSchema = z.object({
  name: z.string().trim().min(1).max(200),
  schedule: automationScheduleSchema,
  prompt: z.string().trim().min(1).max(64_000),
  directory: z.string().trim().min(1).max(1_000),
  scriptCommand: z.string().trim().min(1).max(8_000).nullable(),
  suppressSilent: z.boolean(),
  agent: automationAgentSchema.nullable(),
  // Initial model/effort seed for the spawned session (null/absent = agent default).
  // Older daemons strip these unknown keys and simply spawn with their defaults.
  model: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
  githubTrigger: githubTriggerSchema.optional(),
  seal: automationSealSchema.optional(),
}).superRefine((payload, context) => {
  const isGithubSchedule = payload.schedule.kind === 'github';
  if (isGithubSchedule !== (payload.githubTrigger !== undefined)) {
    context.addIssue({
      code: 'custom',
      path: ['schedule'],
      message: 'github schedule and githubTrigger must be used together',
    });
  }
});
export type AutomationPayload = z.infer<typeof automationPayloadSchema>;

export const automationPublicSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  ownerAccountId: z.string().min(1),
  machineAccountId: z.string().min(1).nullable(),
  machineId: z.string().min(1).nullable(),
  revision: positiveInteger,
  generation: positiveInteger,
  payloadVersion: z.literal(1),
  payloadCiphertext: payloadCiphertextSchema,
  viewerKeyId: z.string().min(1).max(128),
  viewerKeyVersion: positiveInteger,
  viewerKeyEnvelope: envelopeSchema,
  machineKeyVersion: positiveInteger,
  paused: z.boolean(),
  enabledAt: timestamp,
  runRequestedAt: timestamp.nullable().default(null),
  appliedRevision: z.number().int().min(0),
  appliedAt: timestamp.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type AutomationPublic = z.infer<typeof automationPublicSchema>;

export const automationTargetSchema = z.object({
  machineAccountId: z.string().min(1),
  machineId: z.string().min(1),
  machinePublicKey: publicKeySchema,
  machineKeyVersion: positiveInteger,
  viewerPublicKey: publicKeySchema.nullable(),
  viewerKeyVersion: z.number().int().min(0),
  automationProtocolVersion: positiveInteger.default(1),
  sessionFollowupSupported: z.boolean().default(false),
});
export type AutomationTarget = z.infer<typeof automationTargetSchema>;

export const automationRunStatusSchema = z.enum([
  'CLAIMED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED', 'ABANDONED',
]);
export const automationRunOutcomeSchema = z.enum(['WOKE', 'SILENT', 'SKIPPED_GATE', 'ERROR']);
export const automationRunSchema = z.object({
  id: z.string().min(1),
  automationId: z.string().min(1),
  generation: positiveInteger,
  scheduledFor: timestamp,
  machineId: z.string().min(1),
  status: automationRunStatusSchema,
  sessionId: z.string().min(1).nullable(),
  outcome: automationRunOutcomeSchema.nullable(),
  detailCiphertext: base64Schema(PAYLOAD_MAX_BYTES).nullable(),
  failureCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).nullable().optional(),
  degradedCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).nullable().optional(),
  queueDepth: z.number().int().min(0).max(10_000).nullable().optional(),
  queuePosition: z.number().int().min(0).max(10_000).nullable().optional(),
  queueTotal: z.number().int().min(0).max(10_000).nullable().optional(),
  queueEstimatedAt: timestamp.nullable().optional(),
  claimedAt: timestamp,
  startedAt: timestamp.nullable(),
  completedAt: timestamp.nullable(),
  lateReport: z.boolean(),
});
export type AutomationRun = z.infer<typeof automationRunSchema>;

export const automationEncryptedFieldsSchema = z.object({
  payloadVersion: z.literal(1),
  payloadCiphertext: payloadCiphertextSchema,
  viewerKeyId: z.string().min(1).max(128),
  viewerKeyVersion: positiveInteger,
  viewerKeyEnvelope: envelopeSchema,
  machineKeyVersion: positiveInteger,
  machineKeyEnvelope: machineEnvelopeSchema,
});
export type AutomationEncryptedFields = z.infer<typeof automationEncryptedFieldsSchema>;

export const automationCreateRequestSchema = automationEncryptedFieldsSchema.extend({ paused: z.boolean().default(false) });
export type AutomationCreateRequest = z.input<typeof automationCreateRequestSchema>;

export const automationAdoptRequestSchema = automationEncryptedFieldsSchema.extend({
  legacyMachineId: z.string().trim().min(1).max(200),
  legacyAutomationId: z.string().trim().min(1).max(200),
  ownershipConfirmed: z.literal(true),
  desiredPaused: z.boolean(),
});
export type AutomationAdoptRequest = z.input<typeof automationAdoptRequestSchema>;
export interface AutomationAdoption {
  automation: AutomationPublic;
  migrationPending: boolean;
  desiredPaused: boolean;
}

export const automationUpdateRequestSchema = z.object({
  expectedRevision: positiveInteger,
  paused: z.boolean().optional(),
  payloadVersion: z.literal(1).optional(),
  payloadCiphertext: payloadCiphertextSchema.optional(),
  viewerKeyId: z.string().min(1).max(128).optional(),
  viewerKeyVersion: positiveInteger.optional(),
  viewerKeyEnvelope: envelopeSchema.optional(),
  machineKeyVersion: positiveInteger.optional(),
  machineKeyEnvelope: machineEnvelopeSchema.optional(),
}).superRefine((value, ctx) => {
  const encryptedKeys = [
    'payloadVersion', 'payloadCiphertext', 'viewerKeyId', 'viewerKeyVersion',
    'viewerKeyEnvelope', 'machineKeyVersion', 'machineKeyEnvelope',
  ] as const;
  const present = encryptedKeys.filter((key) => value[key] !== undefined).length;
  if (present === 0 && value.paused === undefined) {
    ctx.addIssue({ code: 'custom', message: 'patch must change paused or encrypted payload' });
  }
  if (present !== 0 && present !== encryptedKeys.length) {
    ctx.addIssue({ code: 'custom', message: 'encrypted payload fields must be replaced together' });
  }
});
export type AutomationUpdateRequest = z.infer<typeof automationUpdateRequestSchema>;

export const automationDeleteRequestSchema = z.object({ expectedRevision: positiveInteger });
export const automationActivateAdoptionRequestSchema = z.object({ expectedRevision: positiveInteger });
export const automationViewerKeyRequestSchema = z.object({
  expectedKeyVersion: z.number().int().min(0),
  publicKey: publicKeySchema,
});

export interface AutomationCryptoAdapter {
  randomBytes(length: number): Uint8Array;
  secretBoxSeal(plaintext: Uint8Array, key: Uint8Array): Uint8Array;
  secretBoxOpen(bundle: Uint8Array, key: Uint8Array): Uint8Array | null;
  boxSeal(plaintext: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array;
  boxOpen(bundle: Uint8Array, recipientSecretKey: Uint8Array): Uint8Array | null;
  sha256(value: Uint8Array): Promise<Uint8Array>;
  encodeBase64(value: Uint8Array, urlSafe?: boolean): string;
  decodeBase64(value: string): Uint8Array;
}

function versioned(value: Uint8Array): Uint8Array {
  const result = new Uint8Array(value.length + 1);
  result[0] = 1;
  result.set(value, 1);
  return result;
}

function openVersioned(value: string, crypto: AutomationCryptoAdapter, exactLength?: number): Uint8Array {
  const decoded = crypto.decodeBase64(value);
  if (decoded[0] !== 1 || (exactLength !== undefined && decoded.length !== exactLength)) {
    throw new Error('automation-decrypt-failed');
  }
  return decoded.slice(1);
}

/**
 * With `sender`, the machine's envelope is a v3 one sealed by that key
 * (aplus-dev-studio specs/e2ee-machine-control-boundary R12), and the payload
 * must carry the `seal` the sender vouches for. Without it, both envelopes are
 * anonymous as before.
 */
export async function encryptAutomationPayload(input: {
  payload: AutomationPayload;
  viewer: { publicKey: Uint8Array; keyVersion: number };
  machine: { publicKey: Uint8Array; keyVersion: number };
  sender?: { publicKey: Uint8Array; secretKey: Uint8Array };
  crypto: AutomationCryptoAdapter;
}): Promise<AutomationEncryptedFields> {
  const payload = automationPayloadSchema.parse(input.payload);
  if (input.viewer.publicKey.length !== 32 || input.machine.publicKey.length !== 32
    || (input.sender && !payload.seal)) {
    throw new Error('automation-encrypt-failed');
  }
  const dek = input.crypto.randomBytes(32);
  if (dek.length !== 32) throw new Error('automation-encrypt-failed');
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = versioned(input.crypto.secretBoxSeal(plaintext, dek));
  const result = {
    payloadVersion: 1 as const,
    payloadCiphertext: input.crypto.encodeBase64(ciphertext),
    viewerKeyId: input.crypto.encodeBase64(await input.crypto.sha256(input.viewer.publicKey), true),
    viewerKeyVersion: input.viewer.keyVersion,
    viewerKeyEnvelope: input.crypto.encodeBase64(versioned(input.crypto.boxSeal(dek, input.viewer.publicKey))),
    machineKeyVersion: input.machine.keyVersion,
    machineKeyEnvelope: input.crypto.encodeBase64(input.sender
      ? sealMachineKey({ dek, ciphertext, recipientPublicKey: input.machine.publicKey, sender: input.sender })
      : versioned(input.crypto.boxSeal(dek, input.machine.publicKey))),
  };
  return automationEncryptedFieldsSchema.parse(result);
}

function sealMachineKey(input: {
  dek: Uint8Array;
  ciphertext: Uint8Array;
  recipientPublicKey: Uint8Array;
  sender: { publicKey: Uint8Array; secretKey: Uint8Array };
}): Uint8Array {
  try {
    return sealAuthenticatedEnvelope({
      key: input.dek,
      binding: authenticatedEnvelopeBinding({ kind: 'automation', ciphertext: input.ciphertext }),
      recipientPublicKey: input.recipientPublicKey,
      sender: input.sender,
    });
  } catch {
    throw new Error('automation-encrypt-failed');
  }
}

/**
 * The daemon's side: opens the machine's copy, anonymous or v3, and says which.
 * Whether to trust the sender, and what to check in `seal`, is the caller's.
 */
export function openAutomationPayloadForMachine(input: {
  payloadVersion: 1;
  payloadCiphertext: string;
  machineKeyEnvelope: string;
  recipientSecretKey: Uint8Array;
  crypto: AutomationCryptoAdapter;
}): MachinePayloadOpening<AutomationPayload> {
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
    kind: 'automation',
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
    const payload = automationPayloadSchema.safeParse(JSON.parse(new TextDecoder().decode(plaintext)));
    if (!payload.success) return { ok: false, reason: 'malformed' };
    return { ok: true, payload: payload.data, authentication: opened.authentication };
  } catch {
    return { ok: false, reason: 'malformed' };
  } finally {
    opened.key.fill(0);
  }
}

export async function decryptAutomationPayload(input: {
  payloadVersion: 1;
  payloadCiphertext: string;
  keyEnvelope: string;
  recipientSecretKey: Uint8Array;
  crypto: AutomationCryptoAdapter;
}): Promise<AutomationPayload> {
  try {
    if (input.payloadVersion !== 1 || input.recipientSecretKey.length !== 32) throw new Error();
    const encryptedDek = openVersioned(input.keyEnvelope, input.crypto, ENVELOPE_BYTES);
    const dek = input.crypto.boxOpen(encryptedDek, input.recipientSecretKey);
    if (!dek || dek.length !== 32) throw new Error();
    const encryptedPayload = openVersioned(input.payloadCiphertext, input.crypto);
    const plaintext = input.crypto.secretBoxOpen(encryptedPayload, dek);
    if (!plaintext) throw new Error();
    return automationPayloadSchema.parse(JSON.parse(new TextDecoder().decode(plaintext)));
  } catch {
    throw new Error('automation-decrypt-failed');
  }
}

export class AutomationApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly latest: AutomationPublic | null = null,
  ) {
    super(code);
    this.name = 'AutomationApiError';
  }
}

export interface AutomationFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type AutomationFetch = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: string;
}) => Promise<AutomationFetchResponse>;

export interface AutomationApiClient {
  getTarget(projectId: string): Promise<AutomationTarget>;
  setViewerKey(projectId: string, input: z.infer<typeof automationViewerKeyRequestSchema>): Promise<{ keyVersion: number }>;
  replaceViewerKeyIfUnused(projectId: string, input: z.infer<typeof automationViewerKeyRequestSchema>): Promise<{ keyVersion: number }>;
  listAutomations(projectId: string): Promise<AutomationPublic[]>;
  createAutomation(projectId: string, input: AutomationCreateRequest): Promise<AutomationPublic>;
  adoptAutomation(projectId: string, input: AutomationAdoptRequest): Promise<AutomationAdoption>;
  activateAutomationAdoption(projectId: string, automationId: string, expectedRevision: number): Promise<AutomationPublic>;
  updateAutomation(projectId: string, automationId: string, input: AutomationUpdateRequest): Promise<AutomationPublic>;
  deleteAutomation(projectId: string, automationId: string, expectedRevision: number): Promise<AutomationPublic>;
  runAutomationNow(projectId: string, automationId: string, expectedRevision: number): Promise<AutomationPublic>;
  listRuns(projectId: string, input?: { automationId?: string; limit?: number }): Promise<AutomationRun[]>;
}

function pathId(value: string): string {
  return encodeURIComponent(value);
}

export function createAutomationApiClient(options: {
  baseUrl: string;
  token: string;
  fetch: AutomationFetch;
}): AutomationApiClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  async function request<T>(path: string, schema: z.ZodType<T>, method = 'GET', body?: unknown): Promise<T> {
    const response = await options.fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${options.token}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    if (!response.ok) {
      const parsed = z.object({
        error: z.string().min(1),
        latest: automationPublicSchema.optional(),
      }).safeParse(value);
      throw new AutomationApiError(
        response.status,
        parsed.success ? parsed.data.error : 'automation-request-failed',
        parsed.success ? parsed.data.latest ?? null : null,
      );
    }
    return schema.parse(value);
  }

  const automationPath = (projectId: string) => `/v1/projects/${pathId(projectId)}/automations`;
  return {
    async getTarget(projectId) {
      const value = await request(`/v1/projects/${pathId(projectId)}/automation-target`, z.object({ target: automationTargetSchema }));
      return value.target;
    },
    async setViewerKey(projectId, input) {
      return request(
        `/v1/projects/${pathId(projectId)}/automation-viewer-key`,
        z.object({ keyVersion: positiveInteger }),
        'PUT',
        automationViewerKeyRequestSchema.parse(input),
      );
    },
    async replaceViewerKeyIfUnused(projectId, input) {
      return request(
        `/v1/projects/${pathId(projectId)}/automation-viewer-key/replace-if-unused`,
        z.object({ keyVersion: positiveInteger }),
        'PUT',
        automationViewerKeyRequestSchema.parse(input),
      );
    },
    async listAutomations(projectId) {
      const value = await request(automationPath(projectId), z.object({ automations: z.array(automationPublicSchema) }));
      return value.automations;
    },
    async createAutomation(projectId, input) {
      const value = await request(
        automationPath(projectId),
        z.object({ automation: automationPublicSchema }),
        'POST',
        automationCreateRequestSchema.parse(input),
      );
      return value.automation;
    },
    async adoptAutomation(projectId, input) {
      return request(
        `/v1/projects/${pathId(projectId)}/automation-adoptions`,
        z.object({
          automation: automationPublicSchema,
          migrationPending: z.boolean(),
          desiredPaused: z.boolean(),
        }),
        'POST',
        automationAdoptRequestSchema.parse(input),
      );
    },
    async activateAutomationAdoption(projectId, automationId, expectedRevision) {
      const value = await request(
        `/v1/projects/${pathId(projectId)}/automation-adoptions/${pathId(automationId)}/activate`,
        z.object({ automation: automationPublicSchema }),
        'POST',
        automationActivateAdoptionRequestSchema.parse({ expectedRevision }),
      );
      return value.automation;
    },
    async updateAutomation(projectId, automationId, input) {
      const value = await request(
        `${automationPath(projectId)}/${pathId(automationId)}`,
        z.object({ automation: automationPublicSchema }),
        'PATCH',
        automationUpdateRequestSchema.parse(input),
      );
      return value.automation;
    },
    async deleteAutomation(projectId, automationId, expectedRevision) {
      const body = automationDeleteRequestSchema.parse({ expectedRevision });
      const value = await request(
        `${automationPath(projectId)}/${pathId(automationId)}`,
        z.object({ automation: automationPublicSchema }),
        'DELETE',
        body,
      );
      return value.automation;
    },
    async runAutomationNow(projectId, automationId, expectedRevision) {
      const body = automationDeleteRequestSchema.parse({ expectedRevision });
      const value = await request(
        `${automationPath(projectId)}/${pathId(automationId)}/run`,
        z.object({ automation: automationPublicSchema }),
        'POST',
        body,
      );
      return value.automation;
    },
    async listRuns(projectId, input = {}) {
      const query = new URLSearchParams();
      if (input.automationId) query.set('automationId', input.automationId);
      if (input.limit !== undefined) query.set('limit', String(input.limit));
      const suffix = query.size > 0 ? `?${query.toString()}` : '';
      const value = await request(
        `/v1/projects/${pathId(projectId)}/automation-runs${suffix}`,
        z.object({ runs: z.array(automationRunSchema) }),
      );
      return value.runs;
    },
  };
}
