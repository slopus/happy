import type { OAuthCredential } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { ModelCredentialFailedState, ModelCredentialRetireReason } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { serializeModelSecret } from "./model-secret.js";
import { PiRuntimeCredentialStore } from "./pi-credentials.js";
import {
  matchesFailedOAuthSecret,
  OAUTH_ACCOUNT_CHANGED_ERROR,
  OAUTH_RECONNECT_REQUIRED_ERROR,
  RetiredModelCredentialError,
} from "./pi-oauth.js";

function credential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60 * 60_000,
    ...overrides,
  };
}

describe("PiRuntimeCredentialStore", () => {
  it("resolves a saved Azure API key through the renamed provider", async () => {
    const store = new PiRuntimeCredentialStore("azure-openai-responses", {
      type: "api_key",
      key: "test-azure-key",
    });
    const models = builtinModels({ credentials: store });
    const model = models.getModel("azure", "gpt-4o")!;
    expect(model).toMatchObject({ provider: "azure", id: "gpt-4o" });
    expect((await models.getAuth(model))?.auth.apiKey).toBe("test-azure-key");
    expect(await store.list()).toEqual([{ providerId: "azure", type: "api_key" }]);
    await store.modify("azure", async () => ({ type: "api_key", key: "replacement-key" }));
    expect(await store.read("azure-openai-responses")).toEqual({
      type: "api_key",
      key: "replacement-key",
    });
    await store.delete("azure-openai-responses");
    expect(await store.read("azure")).toBeUndefined();
  });

  it("does not configure openai-codex without a stored OAuth credential", async () => {
    expect(await builtinModels().getAuth("openai-codex")).toBeUndefined();
  });

  it("bridges an encrypted OAuth credential into the OAuth-only Codex provider", async () => {
    const store = new PiRuntimeCredentialStore("openai-codex", credential());
    const models = builtinModels({ credentials: store });

    const auth = await models.getAuth("openai-codex");

    expect(auth?.auth.apiKey).toBe("access-token");
    expect(await store.list()).toEqual([{ providerId: "openai-codex", type: "oauth" }]);
  });

  it("serializes refresh publication without exposing credential values in metadata", async () => {
    let persisted: OAuthCredential | undefined;
    const store = new PiRuntimeCredentialStore(
      "openai-codex",
      credential({ access: "old-access" }),
      async (next) => {
        persisted = next;
      },
    );

    await store.modify("openai-codex", async () => credential({ access: "new-access" }));

    expect(persisted?.access).toBe("new-access");
    expect(await store.list()).toEqual([{ providerId: "openai-codex", type: "oauth" }]);
  });

  it("retires once when a mid-run refresh is terminally rejected", async () => {
    const retire = vi.fn(async () => undefined);
    const store = new PiRuntimeCredentialStore("openai-codex", credential(), undefined, retire);
    const failure = new Error("OAuth refresh failed for openai-codex", {
      cause: new Error('OpenAI Codex token refresh failed (400): {"error":"invalid_grant"}'),
    });

    await expect(
      store.modify("openai-codex", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(retire).toHaveBeenCalledTimes(1);
    expect(retire).toHaveBeenCalledWith(
      "terminal-refresh-failure",
      "invalid_grant",
      // The credential state the failed refresh was attempted on.
      expect.objectContaining({
        access: "access-token",
        refresh: "refresh-token",
      }),
    );
    // The failed refresh must not clear the in-memory credential itself.
    expect(await store.list()).toEqual([{ providerId: "openai-codex", type: "oauth" }]);
  });

  it("settles retirement before the refresh error surfaces", async () => {
    let releaseRetire!: () => void;
    const retireGate = new Promise<undefined>((resolve) => {
      releaseRetire = () => resolve(undefined);
    });
    const retire = vi.fn(() => retireGate);
    const store = new PiRuntimeCredentialStore("openai-codex", credential(), undefined, retire);
    const failure = new Error("OAuth refresh failed for openai-codex", {
      cause: new Error('OpenAI Codex token refresh failed (400): {"error":"invalid_grant"}'),
    });

    let settled = false;
    const modification = store
      .modify("openai-codex", async () => {
        throw failure;
      })
      .then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
    // The delete must commit before the failure can be observed.
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    releaseRetire();
    await modification;
    expect(settled).toBe(true);
  });

  it("does not retire on transient mid-run refresh failures", async () => {
    const retire = vi.fn(async () => undefined);
    const store = new PiRuntimeCredentialStore("openai-codex", credential(), undefined, retire);

    for (const failure of [
      new Error("OAuth refresh failed for openai-codex", {
        cause: new Error('OpenAI Codex token refresh failed (500): {"error":"invalid_grant"}'),
      }),
      new Error("OpenAI Codex token refresh error: socket hang up"),
    ]) {
      await expect(
        store.modify("openai-codex", async () => {
          throw failure;
        }),
      ).rejects.toBe(failure);
    }
    expect(retire).not.toHaveBeenCalled();
  });

  it("surfaces the refresh error when the awaited retirement fails", async () => {
    const retire = vi.fn(async () => {
      throw new Error("database gone");
    });
    const store = new PiRuntimeCredentialStore("openai-codex", credential(), undefined, retire);
    const failure = new Error('refresh failed (400): {"error":"refresh_token_reused"}');

    await expect(
      store.modify("openai-codex", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(retire).toHaveBeenCalledWith(
      "terminal-refresh-failure",
      "refresh_token_reused",
      expect.objectContaining({
        access: "access-token",
        refresh: "refresh-token",
      }),
    );
  });

  it("drops the rejected token after a confirmed terminal refresh", async () => {
    const retire = vi.fn(async () => true);
    const store = new PiRuntimeCredentialStore("openai-codex", credential(), undefined, retire);
    const failure = new Error(
      'refresh failed (400): {"error":"invalid_grant","access":"access-token"}',
    );

    await expect(
      store.modify("openai-codex", async () => {
        throw failure;
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof RetiredModelCredentialError &&
        error.message === OAUTH_RECONNECT_REQUIRED_ERROR,
    );
    expect(await store.read("openai-codex")).toBeUndefined();
    expect(store.accessToken).toBeUndefined();
  });

  it("persists a mid-run refresh that returns the same account", async () => {
    const retire = vi.fn(async () => undefined);
    let persisted: OAuthCredential | undefined;
    const store = new PiRuntimeCredentialStore(
      "openai-codex",
      credential({ access: "old-access", accountId: "acct-a" }),
      async (next) => {
        persisted = next;
      },
      retire,
    );

    await store.modify("openai-codex", async () =>
      credential({ access: "new-access", accountId: "acct-a" }),
    );

    expect(persisted?.access).toBe("new-access");
    expect(retire).not.toHaveBeenCalled();
  });

  it("retires and fails a mid-run refresh that returns a different account", async () => {
    const retire = vi.fn(async () => true);
    const persist = vi.fn(async () => {});
    const store = new PiRuntimeCredentialStore(
      "openai-codex",
      credential({ accountId: "acct-a" }),
      persist,
      retire,
    );

    await expect(
      store.modify("openai-codex", async () =>
        credential({ access: "new-access", accountId: "acct-b" }),
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof RetiredModelCredentialError &&
        error.message === OAUTH_ACCOUNT_CHANGED_ERROR,
    );

    expect(retire).toHaveBeenCalledTimes(1);
    expect(retire).toHaveBeenCalledWith(
      "account-changed",
      "stored account acct-a, refreshed account acct-b",
      // The stored credential state whose refresh produced the foreign account.
      expect.objectContaining({ access: "access-token", refresh: "refresh-token" }),
    );
    // Neither the other account's token nor the rejected one stays readable.
    expect(persist).not.toHaveBeenCalled();
    expect(await store.read("openai-codex")).toBeUndefined();
  });

  it("settles account-change retirement before the error surfaces", async () => {
    let releaseRetire!: () => void;
    const retireGate = new Promise<undefined>((resolve) => {
      releaseRetire = () => resolve(undefined);
    });
    const retire = vi.fn(() => retireGate);
    const store = new PiRuntimeCredentialStore(
      "openai-codex",
      credential({ accountId: "acct-a" }),
      undefined,
      retire,
    );

    let settled = false;
    const modification = store
      .modify("openai-codex", async () => credential({ accountId: "acct-b" }))
      .then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
    // The delete must commit before the account-change failure can be observed.
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    releaseRetire();
    await modification;
    expect(settled).toBe(true);
  });

  it("still fails the refresh when the awaited account-change retirement fails", async () => {
    const retire = vi.fn(async () => {
      throw new Error("database gone");
    });
    const store = new PiRuntimeCredentialStore(
      "openai-codex",
      credential({ accountId: "acct-a" }),
      undefined,
      retire,
    );

    await expect(
      store.modify("openai-codex", async () => credential({ accountId: "acct-b" })),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof RetiredModelCredentialError) &&
        error.message === OAUTH_ACCOUNT_CHANGED_ERROR,
    );
    expect(retire).toHaveBeenCalledWith(
      "account-changed",
      "stored account acct-a, refreshed account acct-b",
      expect.objectContaining({ access: "access-token", refresh: "refresh-token" }),
    );
  });

  it("passes the stored credential state so a stale account-change retire skips a rotated row", async () => {
    // The row was rewritten by a concurrent successful refresh, so the stale
    // account-change failure must not delete the newer credential.
    const stored = credential({ refresh: "refresh-token", expires: 1, accountId: "acct-a" });
    const rotated = serializeModelSecret({
      kind: "oauth",
      credential: credential({
        refresh: "rotated-refresh",
        expires: 50_000,
        accountId: "acct-a",
      }),
    });
    const deleteCredential = vi.fn();
    const retire = async (
      _reason: ModelCredentialRetireReason,
      _detail?: string,
      failed?: ModelCredentialFailedState,
    ) => {
      const matches = failed ? matchesFailedOAuthSecret(() => rotated, failed) : undefined;
      if (matches && !(await matches({ id: "secret-codex", ciphertext: "cipher-codex" })))
        return false;
      deleteCredential();
      return true;
    };
    const store = new PiRuntimeCredentialStore("openai-codex", stored, undefined, retire);

    await expect(
      store.modify("openai-codex", async () => credential({ accountId: "acct-b" })),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof RetiredModelCredentialError) &&
        error.message === OAUTH_ACCOUNT_CHANGED_ERROR,
    );

    expect(deleteCredential).not.toHaveBeenCalled();
  });

  it("skips an account-change delete when another worker rotated only the access token", async () => {
    const stored = credential({
      access: "old-access",
      refresh: "same-refresh",
      expires: 1,
      accountId: "acct-a",
    });
    const rotated = serializeModelSecret({
      kind: "oauth",
      credential: credential({
        access: "rotated-access",
        refresh: "same-refresh",
        expires: 1,
        accountId: "acct-a",
      }),
    });
    const deleteCredential = vi.fn();
    const retire = async (
      _reason: ModelCredentialRetireReason,
      _detail?: string,
      failed?: ModelCredentialFailedState,
    ) => {
      const matches = failed ? matchesFailedOAuthSecret(() => rotated, failed) : undefined;
      if (matches && !(await matches({ id: "secret-codex", ciphertext: "cipher-codex" })))
        return false;
      deleteCredential();
      return true;
    };
    const store = new PiRuntimeCredentialStore("openai-codex", stored, undefined, retire);

    await expect(
      store.modify("openai-codex", async () => credential({ accountId: "acct-b" })),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof RetiredModelCredentialError) &&
        error.message === OAUTH_ACCOUNT_CHANGED_ERROR,
    );

    expect(deleteCredential).not.toHaveBeenCalled();
  });

  it("tolerates a missing account id on either side of a mid-run refresh", async () => {
    const retire = vi.fn(async () => undefined);
    const persisted: OAuthCredential[] = [];
    const store = new PiRuntimeCredentialStore(
      "openai-codex",
      credential({ access: "old-access" }),
      async (next) => {
        persisted.push(next);
      },
      retire,
    );

    // Stored side has no account id: no comparison, no retirement.
    await store.modify("openai-codex", async () =>
      credential({ access: "new-access", accountId: "acct-b" }),
    );
    // Refreshed side has no account id either.
    await store.modify("openai-codex", async () => credential({ access: "newer-access" }));

    expect(persisted.map((entry) => entry.access)).toEqual(["new-access", "newer-access"]);
    expect(retire).not.toHaveBeenCalled();
  });

  it("ends a coordinated refresh when its time runs out and reports a cancelled one", async () => {
    // The coordinated refresh hands over a signal that ends a provider call it is waiting on.
    const storeFor = (signal: AbortSignal) =>
      new PiRuntimeCredentialStore(
        "openai-codex",
        credential({ access: "old-access" }),
        undefined,
        undefined,
        async (held, refresh) => (await refresh(held, signal)) ?? held,
      );
    const timeout = new AbortController();
    const hanging = storeFor(timeout.signal).modify("openai-codex", () => new Promise(() => {}));
    timeout.abort(new Error("refresh timed out"));
    await expect(hanging).rejects.toThrow("refresh timed out");

    // A run cancelled while the refresh ran does not report the refresh as done.
    const cancel = new AbortController();
    const store = storeFor(new AbortController().signal);
    const cancelled = store.modify(
      "openai-codex",
      async () => {
        cancel.abort(new Error("run cancelled"));
        return credential({ access: "new-access" });
      },
      { signal: cancel.signal },
    );
    await expect(cancelled).rejects.toThrow("run cancelled");
    expect(store.accessToken).toBe("old-access");
  });
});
