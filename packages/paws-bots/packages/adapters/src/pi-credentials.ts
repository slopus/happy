import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
  OAuthCredential,
} from "@earendil-works/pi-ai";
import type { AgentModelOAuthCredential, AgentRunRequest } from "@rakazo/adapter-kit";
import { canonicalPiProviderId } from "@rakazo/contracts";
import { withAbort } from "@rakazo/core";
import type { RetireModelCredential } from "./pi-oauth.js";
import {
  isRetiredModelCredentialError,
  OAUTH_ACCOUNT_CHANGED_ERROR,
  OAUTH_RECONNECT_REQUIRED_ERROR,
  oauthAccountChange,
  RetiredModelCredentialError,
  terminalOAuthRefreshErrorMarker,
  tryRetireModelCredential,
} from "./pi-oauth.js";

export function toOAuthCredential(value: AgentModelOAuthCredential): OAuthCredential {
  return { ...value, type: "oauth" };
}

/**
 * Request-scoped Pi store for one already-authorized provider. Pi's default
 * in-memory store cannot see Rakazo's encrypted database; refreshes are
 * serialized here and published back for encryption.
 */
export class PiRuntimeCredentialStore implements CredentialStore {
  private credential?: Credential;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly providerId: string,
    credential?: Credential,
    private readonly persistOAuth?: (credential: OAuthCredential) => Promise<void>,
    private readonly retireOAuth?: RetireModelCredential,
    private readonly refreshOAuth?: NonNullable<
      NonNullable<AgentRunRequest["model"]["oauth"]>["refresh"]
    >,
  ) {
    this.credential = credential;
    this.providerId = canonicalPiProviderId(providerId);
  }

  /**
   * The token a request resolves to right now. `modify` swaps the stored
   * credential on refresh, so callers must read this per request rather than
   * caching the credential they seeded the store with.
   */
  get accessToken(): string | undefined {
    return this.credential?.type === "oauth" ? this.credential.access : undefined;
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    return canonicalPiProviderId(providerId) === this.providerId ? this.credential : undefined;
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    return this.credential ? [{ providerId: this.providerId, type: this.credential.type }] : [];
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    if (canonicalPiProviderId(providerId) !== this.providerId) return Promise.resolve(undefined);
    const previous = this.chain;
    const operation = previous.then(async () => {
      options?.signal?.throwIfAborted();
      const current = this.credential;
      if (this.refreshOAuth && current?.type === "oauth") {
        // The stored-credential refresh owns the lock, re-read, write and retirement.
        try {
          const next = await this.refreshOAuth(current, async (stored, signal) => {
            const refreshed = await withAbort(fn(toOAuthCredential(stored)), signal);
            return refreshed?.type === "oauth" ? refreshed : undefined;
          });
          options?.signal?.throwIfAborted();
          this.credential = toOAuthCredential(next);
        } catch (error) {
          if (isRetiredModelCredentialError(error)) this.credential = undefined;
          throw error;
        }
        return this.credential;
      }
      let next: Credential | undefined;
      try {
        next = await fn(current);
      } catch (error) {
        const marker = terminalOAuthRefreshErrorMarker(error);
        // Await the retirement so the marker commits before this error surfaces: a
        // detached write could race a catalog read or be dropped by worker shutdown.
        if (
          marker &&
          (await tryRetireModelCredential(
            this.retireOAuth,
            "terminal-refresh-failure",
            marker,
            current?.type === "oauth" ? current : undefined,
          ))
        ) {
          // The rejected access token must not stay available to a later read.
          this.credential = undefined;
          throw new RetiredModelCredentialError(OAUTH_RECONNECT_REQUIRED_ERROR);
        }
        throw error;
      }
      options?.signal?.throwIfAborted();
      if (next !== undefined) {
        if (next.type === "oauth" && next !== current) {
          const stored = current?.type === "oauth" ? current : undefined;
          const accountChange = oauthAccountChange(stored, next);
          if (accountChange) {
            // The refresh belongs to a different account: retire the stored credential
            // instead of persisting the new token. Fail the run permanently only when
            // this call deleted it; a skipped delete means a newer credential survived.
            if (
              await tryRetireModelCredential(
                this.retireOAuth,
                "account-changed",
                accountChange,
                stored,
              )
            ) {
              this.credential = undefined;
              throw new RetiredModelCredentialError(OAUTH_ACCOUNT_CHANGED_ERROR);
            }
            throw new Error(OAUTH_ACCOUNT_CHANGED_ERROR);
          }
          await this.persistOAuth?.(next);
        }
        this.credential = next;
      }
      return this.credential;
    });
    this.chain = operation.catch(() => undefined);
    return operation;
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    if (canonicalPiProviderId(providerId) !== this.providerId) return Promise.resolve();
    const previous = this.chain;
    const operation = previous.then(() => {
      options?.signal?.throwIfAborted();
      this.credential = undefined;
    });
    this.chain = operation.catch(() => undefined);
    return operation;
  }
}
