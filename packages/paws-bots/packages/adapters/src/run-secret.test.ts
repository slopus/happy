import { encodeLoginSecret } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { runLoginKind } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { storeBotSecret } from "./bot-secrets.js";
import { fakeDatabase } from "./bot-secrets.test-support.js";
import {
  commitConsumedRunSecret,
  createRunSecretWriter,
  normalizeSecretAskPurpose,
  reconcileManagedConnection,
  resolveCompletedSecretLeftover,
  resolveMissingRunSecretAction,
  secretPausedToolResult,
  tryCompleteConnectionWithCode,
} from "./run-secret.js";
import { EncryptedSecretStore } from "./secrets.js";

describe("normalizeSecretAskPurpose", () => {
  it("keeps known purposes and defaults unknown ones to otp", () => {
    expect(normalizeSecretAskPurpose("api_key")).toBe("api_key");
    expect(normalizeSecretAskPurpose("password")).toBe("password");
    expect(normalizeSecretAskPurpose("other")).toBe("otp");
    expect(normalizeSecretAskPurpose("otp")).toBe("otp");
    expect(normalizeSecretAskPurpose(undefined)).toBe("otp");
  });
});

describe("secretPausedToolResult", () => {
  it("terminates the agent turn without exposing a value", () => {
    expect(secretPausedToolResult()).toMatchObject({
      terminate: true,
      details: { secret: "paused" },
    });
  });
});

describe("commitConsumedRunSecret", () => {
  it("deletes the stored secret before connector side effects, then persists", async () => {
    const order: string[] = [];
    const result = { ok: true, submitted: true };
    const onPersistFailed = { error: "uncertain", uncertain: true as const };

    await expect(
      commitConsumedRunSecret({
        deleteSecret: async () => {
          order.push("delete");
        },
        afterSecretTaken: async () => {
          order.push("side-effect");
          return result;
        },
        persist: async () => {
          order.push("persist");
          return true;
        },
        onPersistFailed,
      }),
    ).resolves.toBe(result);

    expect(order).toEqual(["delete", "side-effect", "persist"]);
  });

  it("does not keep the secret for a retry after side effects when persist fails", async () => {
    const deleteSecret = vi.fn();
    const onPersistFailed = { error: "uncertain", uncertain: true as const };

    await expect(
      commitConsumedRunSecret({
        deleteSecret,
        afterSecretTaken: async () => ({ ok: true, submitted: true }),
        persist: async () => false,
        onPersistFailed,
      }),
    ).resolves.toBe(onPersistFailed);

    expect(deleteSecret).toHaveBeenCalledOnce();
  });
});

describe("createRunSecretWriter", () => {
  it("refuses to store an answer for a run whose bot changed", async () => {
    const prisma = {
      run: { findFirst: async () => ({ botId: "bot", userId: "user" }) },
      message: {
        findFirst: async () => ({
          blocks: [{ kind: "ask", text: "Code", input: "secret", status: "pending" }],
        }),
      },
    } as unknown as PrismaClient;
    const create = vi.fn();
    const answer = (botId: string) =>
      createRunSecretWriter(new EncryptedSecretStore("fake-key")).withPrepared!(
        prisma,
        {
          spaceId: "space",
          runId: "run",
          threadId: "thread",
          messageId: "message",
          answeredByUserId: "user",
          answer: "fake-code",
        },
        (prepared) =>
          prepared.store({
            botId,
            runId: "run",
            userId: "user",
            spaceId: "space",
            plaintext: "fake-code",
            remember: true,
            tx: { secret: { create } } as never,
          }),
      );

    await expect(answer("other-bot")).rejects.toThrow("Secret request changed");
    expect(create).not.toHaveBeenCalled();
    await answer("bot");
    expect(create).toHaveBeenCalledOnce();
  });
});

describe("answering a login card that replaces a saved login's site", () => {
  const WWW = "https://www.example.test";
  // An international site, as the card shows it: the stored site must be the same string.
  const LOGIN = "https://xn--bcher-kva.example.test";
  const credential = { name: "site_login", origin: LOGIN, auth: { type: "login" as const } };
  const secretStore = new EncryptedSecretStore("test-only-encryption-key");
  const fields = (password: string) => [
    { label: "Username", value: "fake-user", hidden: false },
    { label: "Password", value: password, hidden: true },
  ];
  const typed = (password: string) => encodeLoginSecret({ fields: fields(password) });

  /** A vault with a login saved for www and a run waiting on a card for the new site. */
  async function waitingOn({ replacing = true } = {}) {
    const db = fakeDatabase();
    await storeBotSecret({
      prisma: db.prisma,
      secretStore,
      scope: { userId: "user", spaceId: "space" },
      destination: { ...credential, origin: WWW },
      plaintext: typed("fake-password-www"),
    });
    const ask = {
      credential,
      ...(replacing ? { replaces: { id: db.rows()[0]!.id, origin: WWW } } : {}),
    };
    const runSecrets: Array<Record<string, unknown>> = [];
    Object.assign(db.prisma, {
      run: { findFirst: async () => ({ botId: "bot", userId: "user" }) },
      message: {
        findFirst: async () => ({
          blocks: [{ kind: "ask", text: "Sign in", input: "secret", status: "pending", ...ask }],
        }),
      },
      secret: {
        count: async () => 0,
        findFirst: async () => null,
        deleteMany: async () => ({ count: 0 }),
        create: async ({ data }: { data: Record<string, unknown> }) => runSecrets.push(data),
      },
    });
    return { db, runSecrets, before: db.rows().map((row) => ({ ...row })) };
  }

  function answer(
    db: ReturnType<typeof fakeDatabase>,
    options: { password?: string; remember?: false; by?: string } = {},
  ) {
    const password = options.password ?? "fake-password-login";
    return createRunSecretWriter(secretStore).withPrepared!(
      db.prisma,
      {
        spaceId: "space",
        runId: "run",
        threadId: "thread",
        messageId: "message",
        answeredByUserId: options.by ?? "user",
        answer: "",
        fields: fields(password),
        ...(options.remember === false ? { remember: false as const } : {}),
      },
      (writer) =>
        db.prisma.$transaction((tx) =>
          writer.store({
            botId: "bot",
            credential,
            remember: options.remember !== false,
            runId: "run",
            userId: "user",
            spaceId: "space",
            plaintext: typed(password),
            tx: tx as never,
          }),
        ),
    );
  }

  it("saves the login for the card's site in place of the one for the old site", async () => {
    const { db, before } = await waitingOn();
    await answer(db);
    expect(db.rows()).toHaveLength(1);
    const [row] = db.rows();
    expect(row).toMatchObject({ id: before[0]!.id, name: "site_login", origin: LOGIN });
    expect(await secretStore.load(row!.ciphertext, row!.id)).toBe(typed("fake-password-login"));
    expect(JSON.stringify(db.rows())).not.toContain(WWW);
  });

  it("with Save to Vault off, keeps the saved login and holds this one for the card's site", async () => {
    const { db, runSecrets, before } = await waitingOn();
    await answer(db, { remember: false });
    expect(db.rows()).toEqual(before);
    expect(runSecrets).toEqual([
      expect.objectContaining({ kind: runLoginKind("run", "site_login") }),
    ]);
    const held = JSON.parse(
      await secretStore.load(String(runSecrets[0]!.ciphertext), String(runSecrets[0]!.id)),
    );
    expect(held).toEqual({ origin: LOGIN, login: typed("fake-password-login") });
  });

  it("refuses another member of the chat, changing nothing", async () => {
    const { db, before } = await waitingOn();
    await expect(answer(db, { by: "member" })).rejects.toThrow("Secret request changed; retry");
    expect(db.rows()).toEqual(before);
  });

  it("won't replace a login with a card that wasn't opened to replace it", async () => {
    // Opened when nothing was saved under the name; the www login was saved after.
    const { db, before } = await waitingOn({ replacing: false });
    await expect(answer(db)).rejects.toThrow(
      "Remove the existing credential before changing its destination",
    );
    expect(db.rows()).toEqual(before);
  });
});

describe("resolveCompletedSecretLeftover", () => {
  it("drops a leftover OTP created before the effect completed", () => {
    expect(
      resolveCompletedSecretLeftover({
        secretCreatedAt: new Date("2026-08-27T12:00:00.000Z"),
        effectUpdatedAt: new Date("2026-08-27T12:00:05.000Z"),
      }),
    ).toBe("drop_leftover");
  });

  it("consumes a replacement OTP submitted after the effect completed", () => {
    expect(
      resolveCompletedSecretLeftover({
        secretCreatedAt: new Date("2026-08-27T12:01:00.000Z"),
        effectUpdatedAt: new Date("2026-08-27T12:00:05.000Z"),
      }),
    ).toBe("consume_replacement");
  });
});

describe("resolveMissingRunSecretAction", () => {
  it("replays a completed effect instead of asking again after the secret was deleted", () => {
    const result = { ok: true, submitted: true, connected: true };
    expect(resolveMissingRunSecretAction({ status: "completed", result })).toEqual({
      action: "return",
      result,
    });
  });

  it("settles an in-flight attempt instead of re-asking for a consumed OTP", () => {
    expect(resolveMissingRunSecretAction({ status: "executing" })).toEqual({
      action: "settle_attempt",
    });
  });

  it("asks again when the effect is still waiting for input", () => {
    expect(resolveMissingRunSecretAction({ status: "intended" })).toEqual({ action: "ask" });
    expect(resolveMissingRunSecretAction(undefined)).toEqual({ action: "ask" });
  });
});

describe("reconcileManagedConnection", () => {
  const context = {
    operationId: "run-1",
    traceId: "run-1",
    spaceId: "workspace-1",
    userId: "user-1",
    signal: new AbortController().signal,
  };

  it("marks a pending connection connected when the provider is already ready", async () => {
    const connectionReady = vi.fn().mockResolvedValue(true);
    const prisma = {
      connection: {
        findFirst: vi.fn().mockResolvedValue({
          id: "conn-1",
          connectorId: "composio",
          provider: "gmail",
          status: "pending",
        }),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    const connectors = {
      managed: vi.fn(() => ({ connectionReady })),
    };

    await expect(
      reconcileManagedConnection(
        prisma as never,
        connectors as never,
        { spaceId: "workspace-1", userId: "user-1" },
        context,
        "conn-1",
      ),
    ).resolves.toBe("connected");

    expect(connectionReady).toHaveBeenCalled();
    expect(prisma.connection.update).toHaveBeenCalledWith({
      where: { id: "conn-1" },
      data: { status: "connected" },
    });
  });
});

describe("tryCompleteConnectionWithCode", () => {
  const context = {
    operationId: "run-1",
    traceId: "run-1",
    spaceId: "workspace-1",
    userId: "user-1",
    signal: new AbortController().signal,
  };

  it("forwards the code to a pending managed connector", async () => {
    const complete = vi.fn().mockResolvedValue({ connectionRef: "gmail" });
    const connectionReady = vi.fn().mockResolvedValue(true);
    const prisma = {
      connection: {
        findFirst: vi.fn().mockResolvedValue({
          id: "conn-1",
          connectorId: "composio",
          provider: "gmail",
          providerRef: "gmail-state",
          status: "pending",
        }),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    const connectors = {
      managed: vi.fn(() => ({ complete, connectionReady })),
    };

    await expect(
      tryCompleteConnectionWithCode(
        prisma as never,
        connectors as never,
        { spaceId: "workspace-1", userId: "user-1" },
        context,
        "conn-1",
        "123456",
      ),
    ).resolves.toEqual({ connected: true });

    expect(prisma.connection.findFirst).toHaveBeenCalledWith({
      where: {
        id: "conn-1",
        spaceId: "workspace-1",
        userId: "user-1",
        status: { in: ["pending", "connected"] },
      },
    });
    expect(complete).toHaveBeenCalledWith({ state: "gmail-state", code: "123456" }, context);
    expect(prisma.connection.update).toHaveBeenCalledWith({
      where: { id: "conn-1" },
      data: { status: "connected" },
    });
  });

  it("does not resubmit a code when the connection is already connected", async () => {
    const complete = vi.fn();
    const prisma = {
      connection: {
        findFirst: vi.fn().mockResolvedValue({
          id: "conn-1",
          connectorId: "composio",
          provider: "gmail",
          providerRef: "gmail-state",
          status: "connected",
        }),
        update: vi.fn(),
      },
    };
    const connectors = {
      managed: vi.fn(() => ({ complete, connectionReady: vi.fn() })),
    };

    await expect(
      tryCompleteConnectionWithCode(
        prisma as never,
        connectors as never,
        { spaceId: "workspace-1", userId: "user-1" },
        context,
        "conn-1",
        "123456",
      ),
    ).resolves.toEqual({ connected: true });

    expect(complete).not.toHaveBeenCalled();
    expect(prisma.connection.update).not.toHaveBeenCalled();
  });

  it("returns a connector error instead of throwing", async () => {
    const complete = vi.fn().mockRejectedValue(new Error("invalid code"));
    const prisma = {
      connection: {
        findFirst: vi.fn().mockResolvedValue({
          id: "conn-1",
          connectorId: "composio",
          provider: "gmail",
          providerRef: "gmail-state",
          status: "pending",
        }),
        update: vi.fn(),
      },
    };
    const connectors = {
      managed: vi.fn(() => ({ complete, connectionReady: vi.fn() })),
    };

    await expect(
      tryCompleteConnectionWithCode(
        prisma as never,
        connectors as never,
        { spaceId: "workspace-1", userId: "user-1" },
        context,
        "conn-1",
        "bad",
      ),
    ).resolves.toEqual({ connected: false, error: "Connection could not be completed." });
  });
});
