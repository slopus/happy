import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  SecretContext,
  SecretPutOptions,
  SecretRecord,
  SecretStore,
} from "@rakazo/adapter-kit";
import { SecretNotFoundError, SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import { readBoundedJsonResponse } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { credentialDigest } from "./credential-digest.js";
import { SecretChanges } from "./secret-changes.js";

export { SecretNotFoundError, SecretStoreUnavailableError } from "@rakazo/adapter-kit";

export const INFISICAL_REF_PREFIX = "infisical:v1:";
export interface InfisicalSecretStoreOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment: string;
  folder: string;
  fetch?: typeof fetch;
  cacheMaxEntries?: number;
  cacheTtlMs?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}
type RestResult = { accessToken?: string; expiresIn?: number; secret?: { secretValue?: string } };
type CacheEntry = { value: string; expires: number; timer: ReturnType<typeof setTimeout> };
const SECRETS_PATH = "/api/v4/secrets";
// Infisical rate limits per 60s window; a longer wait is the caller's retry, not ours.
const MAX_RETRY_AFTER_MS = 5_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Targeted REST reads only: no plaintext folder snapshot. */
export class InfisicalSecretStore extends SecretChanges implements SecretStore {
  private token?: { value: string; expires: number };
  private login?: Promise<string>;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly lastSeen = new Map<string, string>();
  private readonly pendingReads = new Map<string, Promise<string>>();
  private readonly reads = new Map<string, Set<{ invalidated: boolean }>>();
  private readonly lifetime = new AbortController();
  private degraded = false;
  private closed = false;
  private readonly now: () => number;
  private readonly fetcher: typeof fetch;
  constructor(private readonly options: InfisicalSecretStoreOptions) {
    super();
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetch ?? fetch;
    if (
      !Number.isSafeInteger(options.cacheMaxEntries ?? 256) ||
      (options.cacheMaxEntries ?? 256) < 1 ||
      !Number.isFinite(options.cacheTtlMs ?? 30_000) ||
      (options.cacheTtlMs ?? 30_000) < 1 ||
      !Number.isSafeInteger(options.timeoutMs ?? 15_000) ||
      (options.timeoutMs ?? 15_000) < 1
    )
      throw new Error("Invalid secret cache or timeout limits");
  }
  describe() {
    return {
      id: "infisical",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { rotate: true, degraded: this.degraded },
    };
  }
  async start(): Promise<void> {
    try {
      await this.authenticate();
      // Reading an absent key fails differently when the project, environment or folder is missing.
      await this.request(`${SECRETS_PATH}/rakazo_start_check?${this.readQuery()}`, "GET");
    } catch (error) {
      if (error instanceof SecretNotFoundError) return;
      this.degraded = true;
      getLogger().warn("Infisical secret storage is unreachable or misconfigured", {
        status: error instanceof SecretStoreUnavailableError ? error.status : undefined,
      });
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    this.lifetime.abort();
    this.token = undefined;
    for (const ref of this.cache.keys()) this.dropCached(ref);
    this.lastSeen.clear();
    this.reads.clear();
    this.clearListeners();
  }
  /** Used by the composing store for cross-process invalidation. */
  invalidate(ref: string): void {
    for (const read of this.reads.get(ref) ?? []) read.invalidated = true;
    this.dropCached(ref);
    // The notification already reports this change; the next read establishes a new baseline.
    this.lastSeen.delete(ref);
    this.changed(ref);
  }
  private dropCached(ref: string): void {
    const entry = this.cache.get(ref);
    if (entry) clearTimeout(entry.timer);
    this.cache.delete(ref);
  }
  private observe(ref: string, value: string): boolean {
    const digest = credentialDigest(value);
    const previous = this.lastSeen.get(ref);
    this.lastSeen.delete(ref);
    while (this.lastSeen.size >= (this.options.cacheMaxEntries ?? 256)) {
      const oldest = this.lastSeen.keys().next().value;
      if (oldest !== undefined) this.lastSeen.delete(oldest);
    }
    this.lastSeen.set(ref, digest);
    return previous !== undefined && previous !== digest;
  }
  private remember(ref: string, value: string): void {
    if (this.closed) return;
    this.dropCached(ref);
    while (this.cache.size >= (this.options.cacheMaxEntries ?? 256)) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.dropCached(oldest);
    }
    const ttl = this.options.cacheTtlMs ?? 30_000;
    const entry: CacheEntry = {
      value,
      expires: this.now() + ttl,
      timer: setTimeout(() => {
        if (this.cache.get(ref) === entry) this.dropCached(ref);
      }, ttl),
    };
    entry.timer.unref?.();
    this.cache.set(ref, entry);
  }
  private key(ref: string, context: SecretContext): string {
    const recordId = typeof context === "string" ? context : context.recordId;
    const prefix = `rakazo_${credentialDigest(recordId).slice(0, 24)}_`;
    const key = ref.slice(INFISICAL_REF_PREFIX.length);
    if (
      !ref.startsWith(INFISICAL_REF_PREFIX) ||
      !key.startsWith(prefix) ||
      !/^rakazo_[a-f0-9]{24}_[a-f0-9-]{36}$/.test(key)
    )
      throw new SecretNotFoundError();
    return key;
  }
  private scope() {
    return {
      projectId: this.options.projectId,
      environment: this.options.environment,
      secretPath: this.options.folder,
      type: "shared",
    };
  }
  private readQuery(): URLSearchParams {
    return new URLSearchParams({
      ...this.scope(),
      expandSecretReferences: "false",
      includeImports: "false",
    });
  }
  async put(
    plaintext: string,
    context: AdapterContext,
    options: SecretPutOptions = {},
  ): Promise<SecretRecord> {
    context.signal.throwIfAborted();
    if (options.ephemeral) throw new Error("Ephemeral secrets require local encrypted storage");
    const recordId = options.recordId ?? randomUUID();
    const key = `rakazo_${credentialDigest(recordId).slice(0, 24)}_${randomUUID()}`;
    const ref = INFISICAL_REF_PREFIX + key;
    try {
      await this.request(
        `${SECRETS_PATH}/${key}`,
        "POST",
        { ...this.scope(), secretValue: plaintext },
        context.signal,
      );
    } catch (error) {
      // The unique key may have been created before the response was lost.
      const cleanupSignal = AbortSignal.timeout(2_000);
      await this.withCancellation(
        this.delete(ref, { recordId, signal: cleanupSignal }),
        cleanupSignal,
      ).catch(() => {
        getLogger().warn("Secret cleanup after a failed write did not complete; a key may remain");
      });
      throw error;
    }
    this.observe(ref, plaintext);
    this.remember(ref, plaintext);
    this.changed(ref);
    return { id: recordId, ref, ciphertext: ref };
  }
  async load(ref: string, context: SecretContext): Promise<string> {
    this.key(ref, context);
    const signal = typeof context === "string" ? undefined : context.signal;
    signal?.throwIfAborted();
    if (this.closed) throw new SecretStoreUnavailableError();
    const cached = this.cache.get(ref);
    if (cached && cached.expires > this.now()) {
      this.cache.delete(ref);
      this.cache.set(ref, cached);
      const digest = this.lastSeen.get(ref);
      if (digest !== undefined) {
        this.lastSeen.delete(ref);
        this.lastSeen.set(ref, digest);
      }
      return cached.value;
    }
    if (cached) this.dropCached(ref);
    let pending = this.pendingReads.get(ref);
    if (!pending) {
      pending = this.loadFresh(ref, context);
      this.pendingReads.set(ref, pending);
      const release = () => {
        if (this.pendingReads.get(ref) === pending) this.pendingReads.delete(ref);
      };
      void pending.then(release, release);
    }
    return this.withCancellation(pending, signal);
  }
  private async loadFresh(ref: string, context: SecretContext): Promise<string> {
    const key = this.key(ref, context);
    const read = { invalidated: false };
    const reads = this.reads.get(ref) ?? new Set<{ invalidated: boolean }>();
    reads.add(read);
    this.reads.set(ref, reads);
    let value: string;
    try {
      const result = await this.request(`${SECRETS_PATH}/${key}?${this.readQuery()}`, "GET");
      if (typeof result?.secret?.secretValue !== "string") {
        this.degraded = true;
        throw new SecretStoreUnavailableError();
      }
      value = result.secret.secretValue;
    } finally {
      reads.delete(read);
      if (!reads.size) this.reads.delete(ref);
    }
    if (this.closed) throw new SecretStoreUnavailableError();
    if (read.invalidated) return this.loadFresh(ref, context);
    const rotated = this.observe(ref, value);
    this.remember(ref, value);
    if (rotated) this.changed(ref);
    return value;
  }

  async delete(ref: string, context: SecretContext): Promise<void> {
    const key = this.key(ref, context);
    try {
      await this.request(
        `${SECRETS_PATH}/${key}`,
        "DELETE",
        this.scope(),
        typeof context === "string" ? undefined : context.signal,
      );
    } catch (error) {
      if (!(error instanceof SecretNotFoundError)) throw error;
    } finally {
      this.invalidate(ref);
    }
  }
  redact(_value: string): string {
    return "[redacted]";
  }
  private async pause(ms: number, signal: AbortSignal): Promise<void> {
    if (this.options.sleep) return this.options.sleep(ms, signal);
    await new Promise<void>((resolve, reject) => {
      signal.throwIfAborted();
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, ms);
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  private async authenticate(): Promise<string> {
    if (this.token && this.token.expires > this.now() + 30_000) return this.token.value;
    if (this.login) return this.login;
    const pending = (async () => {
      const result = await this.http("/api/v1/auth/universal-auth/login", "POST", {
        clientId: this.options.clientId,
        clientSecret: this.options.clientSecret,
      });
      if (typeof result?.accessToken !== "string" || typeof result?.expiresIn !== "number")
        throw new SecretStoreUnavailableError();
      if (this.closed) throw new SecretStoreUnavailableError();
      this.token = { value: result.accessToken, expires: this.now() + result.expiresIn * 1000 };
      this.degraded = false;
      return result.accessToken;
    })();
    this.login = pending;
    try {
      return await pending;
    } finally {
      if (this.login === pending) this.login = undefined;
    }
  }
  private async request(
    path: string,
    method: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<RestResult> {
    try {
      // Caller cancellation doesn't cancel a shared login used by other requests.
      const token = await this.withCancellation(this.authenticate(), signal);
      try {
        return await this.http(path, method, body, token, signal);
      } catch (error) {
        if (!(error instanceof SecretStoreUnavailableError) || error.status !== 401) throw error;
        if (this.token?.value === token) this.token = undefined;
        return await this.http(
          path,
          method,
          body,
          await this.withCancellation(this.authenticate(), signal),
          signal,
        );
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof SecretStoreUnavailableError) this.degraded = true;
      throw error;
    }
  }
  private async withCancellation<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }
  private async http(
    path: string,
    method: string,
    body?: unknown,
    token?: string,
    callerSignal?: AbortSignal,
  ): Promise<RestResult> {
    if (this.closed) throw new SecretStoreUnavailableError();
    const signal = AbortSignal.any([
      this.lifetime.signal,
      ...(callerSignal ? [callerSignal] : []),
      AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
    ]);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await this.fetcher(`${this.options.baseUrl.replace(/\/$/, "")}${path}`, {
          method,
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal,
        });
        if (response.status === 404 && token !== undefined) {
          // A missing project, environment or folder is also a 404, and that is misconfiguration.
          const { message } = await readBoundedJsonResponse<{ message?: unknown }>(
            response,
            MAX_RESPONSE_BYTES,
            signal,
          ).catch(() => ({}) as { message?: unknown });
          if (typeof message !== "string" || !/^Secret\b.*\bnot found$/.test(message))
            throw new SecretStoreUnavailableError(404);
          this.degraded = false;
          throw new SecretNotFoundError();
        }
        if ((response.status === 429 || response.status >= 500) && attempt < 2) {
          await response.body?.cancel();
          const wait =
            retryAfterMs(response.headers.get("retry-after"), this.now()) ?? 100 * 2 ** attempt;
          if (wait > MAX_RETRY_AFTER_MS) throw new SecretStoreUnavailableError(response.status);
          await this.pause(wait, signal);
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new SecretStoreUnavailableError(response.status);
        }
        if (method === "DELETE") {
          await response.body?.cancel();
          this.degraded = false;
          return {};
        }
        const result = await readBoundedJsonResponse<RestResult>(
          response,
          MAX_RESPONSE_BYTES,
          signal,
        );
        this.degraded = false;
        return result;
      } catch (error) {
        if (callerSignal?.aborted) throw callerSignal.reason;
        if (error instanceof SecretNotFoundError || error instanceof SecretStoreUnavailableError)
          throw error;
        throw new SecretStoreUnavailableError();
      }
    }
    throw new SecretStoreUnavailableError();
  }
}

function retryAfterMs(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
