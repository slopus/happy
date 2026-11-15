import type { OAuthCredential } from "@earendil-works/pi-ai";
import type { SecretStore } from "@rakazo/adapter-kit";
import type { PlanLimits, PlanLimitWindow } from "@rakazo/contracts";
import { readBoundedJsonResponse } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { parseModelSecret } from "./model-secret.js";
import {
  ANTHROPIC_OAUTH_PROVIDER,
  CHATGPT_OAUTH_PROVIDER,
  oauthCredentialAccountId,
} from "./pi-oauth.js";

const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 10_000;
/** A fresh reading is reused this long, and a failure is not retried sooner. */
const FRESH_MS = 60_000;
const FAILURE_RETRY_MS = 15_000;
/** Older readings are dropped rather than shown as current. */
const STALE_MS = 30 * 60_000;
const MAX_ENTRIES = 512;

type Reader = {
  /** The subscription's own name, which is what people know their plan by. */
  name: string;
  read: (credential: OAuthCredential, fetchImpl: typeof fetch) => Promise<PlanLimitWindow[]>;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("schema");
  return value as Record<string, unknown>;
}

function percent(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("schema");
  return Math.min(100, Math.max(0, value));
}

/** Seconds since the epoch or an ISO string; anything else is unknown. */
function resetTime(value: unknown): string | null {
  const ms =
    typeof value === "number" ? value * 1000 : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

function periodFor(seconds: unknown): PlanLimitWindow["period"] | null {
  if (typeof seconds !== "number" || seconds <= 0) return null;
  if (seconds <= 86_400) return "session";
  if (seconds <= 8 * 86_400) return "week";
  return "month";
}

async function getJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
): Promise<unknown> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const response = await fetchImpl(url, {
    headers: { ...headers, accept: "application/json" },
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`http ${response.status}`);
  }
  return readBoundedJsonResponse(response, MAX_BYTES, signal);
}

/** Session and weekly windows; per-model weekly limits do not gate the shared allowance. */
export function parseClaudePlanLimits(payload: unknown): PlanLimitWindow[] {
  const body = record(payload);
  const windows: PlanLimitWindow[] = [];
  for (const [key, period] of [
    ["five_hour", "session"],
    ["seven_day", "week"],
  ] as const) {
    if (body[key] == null) continue;
    const window = record(body[key]);
    windows.push({
      period,
      usedPercent: percent(window.utilization),
      resetsAt: resetTime(window.resets_at),
    });
  }
  return windows;
}

/** The account's primary and secondary windows, named by their length. */
export function parseChatGptPlanLimits(payload: unknown): PlanLimitWindow[] {
  const limits = record(record(payload).rate_limit);
  const windows: PlanLimitWindow[] = [];
  for (const key of ["primary_window", "secondary_window"]) {
    if (limits[key] == null) continue;
    const window = record(limits[key]);
    const period = periodFor(window.limit_window_seconds);
    if (!period) continue;
    windows.push({
      period,
      usedPercent: percent(window.used_percent),
      resetsAt: resetTime(window.reset_at),
    });
  }
  return windows;
}

const READERS: Record<string, Reader> = {
  [ANTHROPIC_OAUTH_PROVIDER]: {
    name: "Claude",
    read: async (credential, fetchImpl) =>
      parseClaudePlanLimits(
        await getJson(fetchImpl, "https://api.anthropic.com/api/oauth/usage", {
          authorization: `Bearer ${credential.access}`,
          "anthropic-beta": "oauth-2025-04-20",
        }),
      ),
  },
  [CHATGPT_OAUTH_PROVIDER]: {
    name: "ChatGPT",
    read: async (credential, fetchImpl) => {
      const accountId = oauthCredentialAccountId(credential);
      if (!accountId) throw new Error("account");
      return parseChatGptPlanLimits(
        await getJson(fetchImpl, "https://chatgpt.com/backend-api/wham/usage", {
          authorization: `Bearer ${credential.access}`,
          "chatgpt-account-id": accountId,
          originator: "rakazo",
        }),
      );
    },
  },
};

export const PLAN_LIMIT_PROVIDERS = Object.keys(READERS);

type Entry = { windows: PlanLimitWindow[]; readAt: number; retryAt: number };

/**
 * Reads subscription allowances with the member's own sign-in. Readings are cached per
 * connection so opening a menu never fans out to providers, and a failed read keeps
 * showing the last good one for a while instead of nothing.
 */
export class PlanLimitsReader {
  private readonly cache = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<PlanLimitWindow[] | null>>();

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** Null when the provider has no readable allowance or it could not be read lately. */
  async read(
    key: string,
    provider: string,
    credential: OAuthCredential | null,
  ): Promise<PlanLimitWindow[] | null> {
    const reader = READERS[provider];
    if (!reader) return null;
    const now = this.now();
    const cached = this.cache.get(key);
    // An expired token reads nothing; the caller has a refresh started.
    if (cached && (cached.retryAt > now || !credential || credential.expires <= now))
      return this.current(cached, now);
    if (!credential || credential.expires <= now) return null;
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const task = reader
      .read(credential, this.fetchImpl)
      .then(
        (windows) => {
          this.store(key, { windows, readAt: this.now(), retryAt: this.now() + FRESH_MS });
          return windows.length ? windows : null;
        },
        () => {
          // Provider errors can carry account details; keep only the last good reading.
          const previous = this.cache.get(key);
          if (previous) this.store(key, { ...previous, retryAt: this.now() + FAILURE_RETRY_MS });
          return previous ? this.current(previous, this.now()) : null;
        },
      )
      .finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }

  private current(entry: Entry, now: number): PlanLimitWindow[] | null {
    return entry.windows.length && now - entry.readAt < STALE_MS ? entry.windows : null;
  }

  private store(key: string, entry: Entry) {
    this.cache.delete(key);
    if (this.cache.size >= MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, entry);
  }
}

export const planLimitsReader = new PlanLimitsReader();

/** Allowances for each of the member's subscription sign-ins that can report one. */
export async function readMemberPlanLimits(
  prisma: Pick<PrismaClient, "userModelCredential" | "secret">,
  secretStore: Pick<SecretStore, "load">,
  userId: string,
  reader: PlanLimitsReader,
  onExpiredToken: (secretId: string, provider: string) => void,
): Promise<PlanLimits[]> {
  const rows = await prisma.userModelCredential.findMany({
    where: { userId, provider: { in: PLAN_LIMIT_PROVIDERS } },
    select: { id: true, provider: true, label: true, secretId: true },
    orderBy: { createdAt: "asc" },
  });
  if (!rows.length) return [];
  const secrets = await prisma.secret.findMany({
    where: { id: { in: rows.map((row) => row.secretId) }, userId, spaceId: null },
    select: { id: true, ciphertext: true },
  });
  const ciphertexts = new Map(secrets.map((secret) => [secret.id, secret.ciphertext]));
  const plans = await Promise.all(
    rows.map(async (row) => {
      const ciphertext = ciphertexts.get(row.secretId);
      if (!ciphertext) return null;
      let credential: OAuthCredential | null = null;
      try {
        const stored = parseModelSecret(await secretStore.load(ciphertext, row.secretId));
        // An API key has no subscription allowance to read.
        if (stored.kind !== "oauth" || stored.reconnectRequired) return null;
        credential = stored.credential;
      } catch {
        return null;
      }
      if (credential.expires <= Date.now()) onExpiredToken(row.secretId, row.provider);
      // A new sign-in gets a new secret, so its readings never mix with the old account's.
      const windows = await reader.read(`${userId}:${row.secretId}`, row.provider, credential);
      if (!windows) return null;
      const name = READERS[row.provider]?.name ?? row.label;
      return { credentialId: row.id, name, label: row.label, windows };
    }),
  );
  return plans.filter((plan) => plan !== null);
}
