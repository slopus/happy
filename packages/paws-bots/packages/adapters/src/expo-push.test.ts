import type { BackgroundJob, JobPublisher } from "@rakazo/adapter-kit";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { credentialDigest } from "./credential-digest.js";
import type { ExpoPushTicket } from "./expo-push.js";
import {
  ExpoPushProvider,
  expoPushData,
  expoPushErrorMessage,
  MAX_EXPO_PUSH_RESPONSE_BYTES,
} from "./expo-push.js";

import { MemoryPushTokenStore } from "./push-token-store.test-support.js";

const loadPushToken = async (store: MemoryPushTokenStore, userId: string) =>
  (await store.load(userId))?.token;

afterEach(async () => {
  vi.unstubAllGlobals();
  installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
});

const notifyContext = {
  operationId: "n",
  traceId: "n",
  spaceId: "w",
  userId: "user-1",
  signal: new AbortController().signal,
};

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

describe("expo push tickets", () => {
  it("reads a single Expo ticket and a ticket array", () => {
    expect(expoPushErrorMessage({ data: { status: "ok", id: "1" } }, 200)).toBeUndefined();
    expect(expoPushErrorMessage({ data: { status: "error", message: "bad token" } }, 200)).toBe(
      "bad token",
    );
    expect(expoPushErrorMessage({ errors: [{ message: "rate limited" }] }, 429)).toBe(
      "rate limited",
    );
    expect(expoPushErrorMessage(undefined, 502)).toBe("expo push failed (502)");
    expect(
      expoPushErrorMessage(
        { data: { status: "error", details: { error: "DeviceNotRegistered" } } },
        200,
      ),
    ).toBe("DeviceNotRegistered");
  });
});

describe("expo push", () => {
  it("does not call Expo when the user has no token", async () => {
    const tokens = new MemoryPushTokenStore();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const push = new ExpoPushProvider(tokens);
    await push.send(
      { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
      {
        operationId: "n",
        traceId: "n",
        spaceId: "w",
        userId: "missing",
        signal: new AbortController().signal,
      },
    );
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(push.hasPushRecipient("missing")).resolves.toBe(false);
    await expect(
      push.deliver(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        {
          operationId: "n",
          traceId: "n",
          spaceId: "w",
          userId: "missing",
          signal: new AbortController().signal,
        },
      ),
    ).resolves.toBe("undeliverable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sets the app icon badge when the sender knows the unread count", async () => {
    const tokens = new MemoryPushTokenStore();
    await tokens.save("user-1", "ExponentPushToken[test]");
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ data: { status: "ok", id: "ticket" } })),
      );
    vi.stubGlobal("fetch", fetchMock);
    await new ExpoPushProvider(tokens).send(
      { kind: "completion", title: "Done", body: "", botId: "bot-1", threadId: "th-1", badge: 4 },
      notifyContext,
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ badge: 4 });
  });

  it("posts to Expo when a token is registered", async () => {
    const tokens = new MemoryPushTokenStore();
    await tokens.save("user-1", "ExponentPushToken[test]");
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ data: { status: "ok", id: "ticket" } })),
      );
    vi.stubGlobal("fetch", fetchMock);
    const push = new ExpoPushProvider(tokens);
    await push.send(
      { kind: "takeover", title: "Need you", body: "on screen", botId: "bot-1", threadId: "th-1" },
      notifyContext,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://exp.host/--/api/v2/push/send");
    const body = JSON.parse(String(init.body)) as {
      to: string;
      title: string;
      collapseId: string;
      tag: string;
      data: { kind: string; deliveryId: string };
    };
    expect(body.to).toBe("ExponentPushToken[test]");
    expect(body.title).toBe("Need you");
    expect(body.collapseId).toBe("th-1");
    expect(body.tag).toBe("th-1");
    expect(body.data).toEqual({
      kind: "takeover",
      botId: "bot-1",
      threadId: "th-1",
      spaceId: "w",
      deliveryId: expect.any(String),
    });
    expect(body.data.deliveryId.length).toBeGreaterThan(0);
    expect(body).not.toHaveProperty("badge");

    await push.send(
      { kind: "takeover", title: "Need you", body: "on screen", botId: "bot-1", threadId: "th-1" },
      notifyContext,
    );
    const secondInit = (fetchMock.mock.calls[1] as [string, RequestInit])[1];
    const secondBody = JSON.parse(String(secondInit.body)) as { data: { deliveryId: string } };
    expect(secondBody.data.deliveryId).not.toBe(body.data.deliveryId);
  });

  it("puts the space and group on the payload a tap opens", () => {
    expect(
      expoPushData(
        {
          kind: "completion",
          title: "done",
          body: "ok",
          botId: "bot-1",
          threadId: "thread-1",
          groupId: "group-1",
        },
        "space-1",
        "delivery-1",
      ),
    ).toEqual({
      kind: "completion",
      botId: "bot-1",
      threadId: "thread-1",
      spaceId: "space-1",
      groupId: "group-1",
      deliveryId: "delivery-1",
    });
    expect(
      expoPushData(
        { kind: "completion", title: "done", body: "ok", botId: "bot-1", threadId: "thread-1" },
        "",
        "delivery-2",
      ),
    ).toEqual({
      kind: "completion",
      botId: "bot-1",
      threadId: "thread-1",
      deliveryId: "delivery-2",
    });
  });

  it("does not deliver a token whose session row is gone, and leaves it to be retargeted", async () => {
    const tokens = new MemoryPushTokenStore();
    const token = "ExponentPushToken[test]";
    await tokens.save("user-1", token, "session-1");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const push = new ExpoPushProvider(tokens, { sessionExpiresAt: async () => null });

    await expect(
      push.deliver(
        { kind: "completion", title: "done", body: "secret", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).resolves.toBe("undeliverable");
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(loadPushToken(tokens, "user-1")).resolves.toBe(token);
    await expect(push.hasPushRecipient("user-1")).resolves.toBe(false);

    await tokens.endSession("user-1", "session-1", "session-2");
    await expect(loadPushToken(tokens, "user-1")).resolves.toBe(token);
    const replaced = new ExpoPushProvider(tokens, {
      sessionExpiresAt: async (sessionId) =>
        sessionId === "session-2" ? new Date(Date.now() + 60_000) : null,
    });
    await expect(replaced.hasPushRecipient("user-1")).resolves.toBe(true);
  });

  it("does not deliver a token whose session expiry has passed", async () => {
    const tokens = new MemoryPushTokenStore();
    await tokens.save("user-1", "ExponentPushToken[test]", "session-1");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const push = new ExpoPushProvider(tokens, {
      sessionExpiresAt: async () => new Date(Date.now() - 1_000),
    });

    await expect(
      push.deliver(
        { kind: "completion", title: "done", body: "secret", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).resolves.toBe("undeliverable");
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(loadPushToken(tokens, "user-1")).resolves.toBeUndefined();
  });

  it("does not send a token another account claimed while the session was looked up", async () => {
    const tokens = new MemoryPushTokenStore();
    const token = "ExponentPushToken[device]";
    await tokens.save("user-1", token, "session-1");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let waiting = false;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const push = new ExpoPushProvider(tokens, {
      sessionExpiresAt: async () => {
        waiting = true;
        await gate;
        return new Date(Date.now() + 60_000);
      },
    });

    const delivering = push.deliver(
      { kind: "completion", title: "done", body: "secret", botId: "b", threadId: "t" },
      notifyContext,
    );
    await vi.waitFor(() => expect(waiting).toBe(true));
    await tokens.save("user-2", token, "session-2");
    release();

    await expect(delivering).resolves.toBe("undeliverable");
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(loadPushToken(tokens, "user-1")).resolves.toBeUndefined();
    await expect(loadPushToken(tokens, "user-2")).resolves.toBe(token);
  });

  it("delivers when the registering session is still live", async () => {
    const tokens = new MemoryPushTokenStore();
    await tokens.save("user-1", "ExponentPushToken[test]", "session-1");
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ data: { status: "ok", id: "ticket" } })),
      );
    vi.stubGlobal("fetch", fetchMock);
    const push = new ExpoPushProvider(tokens, {
      sessionExpiresAt: async () => new Date(Date.now() + 60_000),
    });

    await expect(
      push.deliver(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).resolves.toBe("delivered");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not deliver a session-bound token when it cannot check the session", async () => {
    const tokens = new MemoryPushTokenStore();
    await tokens.save("user-1", "ExponentPushToken[test]", "session-1");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const push = new ExpoPushProvider(tokens);

    await expect(
      push.deliver(
        { kind: "completion", title: "done", body: "secret", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).resolves.toBe("undeliverable");
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(loadPushToken(tokens, "user-1")).resolves.toBe("ExponentPushToken[test]");
  });

  it("keeps the token when the session lookup fails", async () => {
    const tokens = new MemoryPushTokenStore();
    await tokens.save("user-1", "ExponentPushToken[test]", "session-1");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const push = new ExpoPushProvider(tokens, {
      sessionExpiresAt: async () => {
        throw new Error("database unavailable");
      },
    });

    await expect(
      push.deliver(
        { kind: "completion", title: "done", body: "secret", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).resolves.toBe("undeliverable");
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(loadPushToken(tokens, "user-1")).resolves.toBe("ExponentPushToken[test]");
  });

  it("throws when Expo rejects the request, leaving the report to the caller", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    const tokens = new MemoryPushTokenStore();
    await tokens.save("user-1", "ExponentPushToken[test]");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ errors: [{ message: "boom" }] }, 400)),
    );
    const push = new ExpoPushProvider(tokens);
    await expect(
      push.send(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).rejects.toThrow("boom");
    expect(sink.events).toEqual([]);
  });

  it("rejects and cancels a declared oversized response", async () => {
    const tokens = new MemoryPushTokenStore();
    await tokens.save("user-1", "ExponentPushToken[test]");
    const response = new Response("oversized", {
      headers: { "content-length": String(MAX_EXPO_PUSH_RESPONSE_BYTES + 1) },
    });
    const cancel = vi.spyOn(response.body!, "cancel");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(
      new ExpoPushProvider(tokens).send(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).rejects.toThrow("Expo push response is too large.");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not wait past cancellation when an oversized body cancel hangs", async () => {
    const tokens = new MemoryPushTokenStore();
    await tokens.save("user-1", "ExponentPushToken[test]");
    let cancelStarted = false;
    const hangingBody = new ReadableStream<Uint8Array>({
      cancel() {
        cancelStarted = true;
        return new Promise(() => undefined);
      },
    });
    const abort = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        setTimeout(() => abort.abort(), 20);
        return new Response(hangingBody, {
          headers: { "content-length": String(MAX_EXPO_PUSH_RESPONSE_BYTES + 1) },
        });
      }),
    );

    const started = Date.now();
    await expect(
      new ExpoPushProvider(tokens).send(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        { ...notifyContext, signal: abort.signal },
      ),
    ).rejects.toThrow("Expo push response is too large.");
    expect(cancelStarted).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("caps a streamed response without a content length", async () => {
    const tokens = new MemoryPushTokenStore();
    await tokens.save("user-1", "ExponentPushToken[test]");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(new Uint8Array(MAX_EXPO_PUSH_RESPONSE_BYTES + 1))),
    );

    await expect(
      new ExpoPushProvider(tokens).send(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).rejects.toThrow("Expo push response is too large.");
  });

  it("rejects malformed successful responses", async () => {
    const tokens = new MemoryPushTokenStore();
    await tokens.save("user-1", "ExponentPushToken[test]");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json")));

    await expect(
      new ExpoPushProvider(tokens).send(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).rejects.toThrow("Expo push returned an invalid response.");
  });

  it("passes caller cancellation to the Expo request", async () => {
    const tokens = new MemoryPushTokenStore();
    await tokens.save("user-1", "ExponentPushToken[test]");
    const controller = new AbortController();
    controller.abort(new Error("notification cancelled"));
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal?.aborted).toBe(true);
      throw init?.signal?.reason;
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new ExpoPushProvider(tokens).send(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        { ...notifyContext, signal: controller.signal },
      ),
    ).rejects.toThrow("notification cancelled");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws when the Expo request never reaches the network", async () => {
    const tokens = new MemoryPushTokenStore();
    await tokens.save("user-1", "ExponentPushToken[test]");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const push = new ExpoPushProvider(tokens, { retryDelaysMs: [0, 0] });
    await expect(
      push.send(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).rejects.toThrow("offline");
  });

  it("keeps a replacement token when Expo reports the old one unregistered", async () => {
    const tokens = new MemoryPushTokenStore();
    await tokens.save("user-1", "ExponentPushToken[old]");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await tokens.save("user-1", "ExponentPushToken[new]");
        return jsonResponse({
          data: { status: "error", details: { error: "DeviceNotRegistered" } },
        });
      }),
    );
    const push = new ExpoPushProvider(tokens);
    await expect(
      push.deliver(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).resolves.toBe("undeliverable");
    await expect(loadPushToken(tokens, "user-1")).resolves.toBe("ExponentPushToken[new]");
  });

  it("caps the title and body inside Expo's payload limit", async () => {
    const tokens = new MemoryPushTokenStore();
    await tokens.save("user-1", "ExponentPushToken[test]");
    const expo = fakeExpo([{ status: "ok", id: "ticket" }]);
    await new ExpoPushProvider(tokens).send(
      {
        kind: "failure",
        title: "🤖".repeat(500),
        body: "é".repeat(5_000),
        botId: "b",
        threadId: "t",
      },
      notifyContext,
    );
    const [sent] = expo.sent;
    expect(Array.from(sent?.title ?? "")).toHaveLength(100);
    expect(Array.from(sent?.body ?? "")).toHaveLength(180);
    expect(sent?.body.endsWith("…")).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(sent))).toBeLessThan(4096);
  });
});

/**
 * Stateful stand-in for Expo's push API: each send consumes the next scripted
 * outcome, a ticket or a whole-request failure, and receipts come from a map.
 * With `requiredAccessToken` the project enforces enhanced push security and
 * rejects any request without that bearer token.
 */
type ExpoOutcome = ExpoPushTicket | { httpStatus: number; errors?: string } | "network";

function fakeExpo(
  outcomes: ExpoOutcome[],
  receipts: Record<string, ExpoPushTicket> = {},
  requiredAccessToken?: string,
) {
  const sent: Array<{ to: string; title: string; body: string }> = [];
  const receiptRequests: string[][] = [];
  const authorizations: Array<string | null> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get("authorization");
    authorizations.push(authorization);
    if (requiredAccessToken && authorization !== `Bearer ${requiredAccessToken}`) {
      return jsonResponse(
        {
          errors: [
            {
              code: "UNAUTHORIZED",
              message: "The bearer token is invalid; it may have been revoked.",
              isTransient: false,
            },
          ],
        },
        401,
      );
    }
    const payload = JSON.parse(String(init?.body));
    if (url.endsWith("/push/getReceipts")) {
      receiptRequests.push(payload.ids);
      const outcome = outcomes.shift();
      if (outcome === "network") throw new TypeError("fetch failed");
      if (outcome && typeof outcome === "object" && "httpStatus" in outcome) {
        return jsonResponse(
          { errors: [{ message: outcome.errors ?? "unavailable" }] },
          outcome.httpStatus,
        );
      }
      return jsonResponse({
        data: Object.fromEntries(
          (payload.ids as string[]).flatMap((id) => (receipts[id] ? [[id, receipts[id]]] : [])),
        ),
      });
    }
    sent.push(payload);
    const outcome = outcomes.shift() ?? { status: "ok", id: `ticket-${sent.length}` };
    if (outcome === "network") throw new TypeError("fetch failed");
    if ("httpStatus" in outcome) {
      return jsonResponse(
        { errors: [{ message: outcome.errors ?? "unavailable" }] },
        outcome.httpStatus,
      );
    }
    return jsonResponse({ data: [outcome] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { sent, receiptRequests, authorizations, fetchMock };
}

function recordingJobs() {
  const enqueued: BackgroundJob[] = [];
  const jobs: JobPublisher = {
    enqueue: async (job) => {
      enqueued.push(job);
    },
    enqueueIn: async () => undefined,
    cancelIn: async () => undefined,
    cancel: async () => undefined,
    close: async () => undefined,
  };
  return { jobs, enqueued };
}

const pushMessage = {
  kind: "completion",
  title: "done",
  body: "ok",
  botId: "b",
  threadId: "t",
} as const;

describe("expo push delivery outcomes", () => {
  it.each<{
    name: string;
    outcomes: ExpoOutcome[];
    result: "delivered" | "undeliverable" | RegExp;
    posts: number;
    tokenKept: boolean;
  }>([
    {
      name: "an accepted ticket",
      outcomes: [{ status: "ok", id: "t1" }],
      result: "delivered",
      posts: 1,
      tokenKept: true,
    },
    {
      name: "a 429 then success",
      outcomes: [{ httpStatus: 429 }],
      result: "delivered",
      posts: 2,
      tokenKept: true,
    },
    {
      name: "a 5xx then success",
      outcomes: [{ httpStatus: 503 }],
      result: "delivered",
      posts: 2,
      tokenKept: true,
    },
    {
      name: "a network failure then success",
      outcomes: ["network"],
      result: "delivered",
      posts: 2,
      tokenKept: true,
    },
    {
      name: "MessageRateExceeded then success",
      outcomes: [
        { status: "error", message: "slow down", details: { error: "MessageRateExceeded" } },
      ],
      result: "delivered",
      posts: 2,
      tokenKept: true,
    },
    {
      name: "a 5xx on every attempt",
      outcomes: [
        { httpStatus: 502, errors: "down" },
        { httpStatus: 502, errors: "down" },
        { httpStatus: 502, errors: "down" },
      ],
      result: /down/,
      posts: 3,
      tokenKept: true,
    },
    {
      name: "a 400",
      outcomes: [{ httpStatus: 400, errors: "bad payload" }],
      result: /bad payload/,
      posts: 1,
      tokenKept: true,
    },
    {
      name: "InvalidCredentials",
      outcomes: [
        { status: "error", message: "no credentials", details: { error: "InvalidCredentials" } },
      ],
      result: /no credentials/,
      posts: 1,
      tokenKept: true,
    },
    {
      name: "DeviceNotRegistered",
      outcomes: [{ status: "error", message: "gone", details: { error: "DeviceNotRegistered" } }],
      result: "undeliverable",
      posts: 1,
      tokenKept: false,
    },
  ])("handles $name", async ({ outcomes, result, posts, tokenKept }) => {
    const tokens = new MemoryPushTokenStore();
    await tokens.save("user-1", "ExponentPushToken[test]");
    const expo = fakeExpo(outcomes);
    const push = new ExpoPushProvider(tokens, { retryDelaysMs: [0, 0] });

    const delivery = push.deliver(pushMessage, notifyContext);
    if (typeof result === "string") await expect(delivery).resolves.toBe(result);
    else await expect(delivery).rejects.toThrow(result);

    expect(expo.sent).toHaveLength(posts);
    await expect(loadPushToken(tokens, "user-1")).resolves.toBe(
      tokenKept ? "ExponentPushToken[test]" : undefined,
    );
  });

  it("retries when the connection drops while the reply is read", async () => {
    const tokens = new MemoryPushTokenStore();
    await tokens.save("user-1", "ExponentPushToken[test]");
    const dropped = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new TypeError("terminated"));
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(dropped))
      .mockResolvedValueOnce(jsonResponse({ data: { status: "ok", id: "ticket" } }));
    vi.stubGlobal("fetch", fetchMock);
    const push = new ExpoPushProvider(tokens, { retryDelaysMs: [0] });

    await expect(push.deliver(pushMessage, notifyContext)).resolves.toBe("delivered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not fail a notification whose device is gone", async () => {
    const tokens = new MemoryPushTokenStore();
    await tokens.save("user-1", "ExponentPushToken[test]");
    fakeExpo([{ status: "error", message: "gone", details: { error: "DeviceNotRegistered" } }]);
    const push = new ExpoPushProvider(tokens);

    await expect(push.send(pushMessage, notifyContext)).resolves.toBeUndefined();
    await expect(push.hasPushRecipient("user-1")).resolves.toBe(false);
  });

  it("stops backing off when the caller cancels", async () => {
    const tokens = new MemoryPushTokenStore();
    await tokens.save("user-1", "ExponentPushToken[test]");
    const expo = fakeExpo([{ httpStatus: 429 }]);
    const controller = new AbortController();
    const push = new ExpoPushProvider(tokens, { retryDelaysMs: [60_000] });

    const delivery = push.deliver(pushMessage, { ...notifyContext, signal: controller.signal });
    await vi.waitFor(() => expect(expo.sent).toHaveLength(1));
    controller.abort(new Error("cancelled"));

    await expect(delivery).rejects.toMatchObject({ name: "AbortError" });
    expect(expo.sent).toHaveLength(1);
  });
});

describe("expo push receipts", () => {
  async function deliveredTicket() {
    const tokens = new MemoryPushTokenStore();
    await tokens.save("user-1", "ExponentPushToken[test]");
    fakeExpo([{ status: "ok", id: "ticket-1" }]);
    const { jobs, enqueued } = recordingJobs();
    const push = new ExpoPushProvider(tokens, { jobs, retryDelaysMs: [0, 0] });
    const before = Date.now();
    await expect(push.deliver(pushMessage, notifyContext)).resolves.toBe("delivered");
    const [job] = enqueued;
    if (job?.name !== "push.receipt") throw new Error("receipt check was not scheduled");
    expect(job.availableAt?.getTime()).toBeGreaterThanOrEqual(before + 15 * 60_000);
    return { tokens, push, receipt: job.payload };
  }

  it("schedules the receipt check without storing the token", async () => {
    const { receipt } = await deliveredTicket();
    expect(receipt).toEqual({
      userId: "user-1",
      ticketId: "ticket-1",
      tokenDigest: credentialDigest("ExponentPushToken[test]"),
    });
    expect(JSON.stringify(receipt)).not.toContain("ExponentPushToken");
  });

  it.each<{ name: string; receipt?: ExpoPushTicket; tokenKept: boolean }>([
    { name: "an ok receipt", receipt: { status: "ok" }, tokenKept: true },
    { name: "a missing receipt", tokenKept: true },
    {
      name: "MessageTooBig",
      receipt: { status: "error", message: "too big", details: { error: "MessageTooBig" } },
      tokenKept: true,
    },
    {
      name: "DeviceNotRegistered",
      receipt: { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } },
      tokenKept: false,
    },
  ])("handles $name", async ({ receipt, tokenKept }) => {
    const { tokens, push, receipt: job } = await deliveredTicket();
    const expo = fakeExpo([], receipt ? { "ticket-1": receipt } : {});

    await expect(push.checkReceipt(job)).resolves.toBeUndefined();

    expect(expo.receiptRequests).toEqual([["ticket-1"]]);
    await expect(loadPushToken(tokens, "user-1")).resolves.toBe(
      tokenKept ? "ExponentPushToken[test]" : undefined,
    );
  });

  it.each([
    { code: "ProviderError", level: "warn" },
    { code: "MessageRateExceeded", level: "warn" },
    { code: "InvalidCredentials", level: "error" },
    { code: "MessageTooBig", level: "error" },
  ])("logs a $code receipt at $level", async ({ code, level }) => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    const { push, receipt } = await deliveredTicket();
    fakeExpo([], { "ticket-1": { status: "error", message: code, details: { error: code } } });

    await push.checkReceipt(receipt);

    expect(
      sink.events.filter((event) => event.message === `expo push receipt error: ${code}`),
    ).toEqual([expect.objectContaining({ level })]);
  });

  it("keeps a token the device registered after the unregistered send", async () => {
    const { tokens, push, receipt } = await deliveredTicket();
    await tokens.save("user-1", "ExponentPushToken[new]");
    fakeExpo([], {
      "ticket-1": { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } },
    });

    await push.checkReceipt(receipt);

    await expect(loadPushToken(tokens, "user-1")).resolves.toBe("ExponentPushToken[new]");
  });

  it("backs off and reads the receipt once Expo answers again", async () => {
    const { tokens, push, receipt } = await deliveredTicket();
    const expo = fakeExpo([{ httpStatus: 503 }], {
      "ticket-1": { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } },
    });

    await expect(push.checkReceipt(receipt)).resolves.toBeUndefined();

    expect(expo.receiptRequests).toHaveLength(2);
    await expect(loadPushToken(tokens, "user-1")).resolves.toBeUndefined();
  });

  it("skips the check without an error while Expo stays unreachable", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    const { tokens, push, receipt } = await deliveredTicket();
    const expo = fakeExpo(["network", "network", "network"]);

    await expect(push.checkReceipt(receipt)).resolves.toBeUndefined();

    expect(expo.receiptRequests).toHaveLength(3);
    await expect(loadPushToken(tokens, "user-1")).resolves.toBe("ExponentPushToken[test]");
    expect(sink.events.some((event) => event.level === "error")).toBe(false);
  });
});

describe("expo push access token", () => {
  async function registeredDevice() {
    const tokens = new MemoryPushTokenStore();
    await tokens.save("user-1", "ExponentPushToken[test]");
    return tokens;
  }

  it("sends the access token as a bearer token on sends and receipts", async () => {
    const tokens = await registeredDevice();
    const expo = fakeExpo([], { "ticket-1": { status: "ok" } }, "expo-access-token");
    const { jobs, enqueued } = recordingJobs();
    const push = new ExpoPushProvider(tokens, { jobs, accessToken: " expo-access-token\n" });

    await expect(push.deliver(pushMessage, notifyContext)).resolves.toBe("delivered");
    const [job] = enqueued;
    if (job?.name !== "push.receipt") throw new Error("receipt check was not scheduled");
    await expect(push.checkReceipt(job.payload)).resolves.toBeUndefined();

    expect(expo.authorizations).toEqual(["Bearer expo-access-token", "Bearer expo-access-token"]);
  });

  it("sends no authorization header without an access token", async () => {
    const tokens = await registeredDevice();
    const expo = fakeExpo([]);
    const push = new ExpoPushProvider(tokens, { accessToken: "  " });

    await expect(push.deliver(pushMessage, notifyContext)).resolves.toBe("delivered");

    expect(expo.authorizations).toEqual([null]);
  });

  it.each<{ name: string; accessToken?: string; error: RegExp }>([
    { name: "a missing token", error: /requires an access token.*EXPO_ACCESS_TOKEN/ },
    { name: "a rejected token", accessToken: "revoked-token", error: /rejected EXPO_ACCESS_TOKEN/ },
  ])("explains a 401 from $name without retrying or echoing it", async ({ accessToken, error }) => {
    const tokens = await registeredDevice();
    const expo = fakeExpo([], {}, "expo-access-token");
    const push = new ExpoPushProvider(tokens, { accessToken, retryDelaysMs: [0, 0] });

    const delivery = push.deliver(pushMessage, notifyContext);
    await expect(delivery).rejects.toThrow(error);
    await expect(delivery).rejects.not.toThrow(/revoked-token/);
    expect(expo.fetchMock).toHaveBeenCalledOnce();
    await expect(loadPushToken(tokens, "user-1")).resolves.toBe("ExponentPushToken[test]");

    await expect(
      push.checkReceipt({ userId: "user-1", ticketId: "ticket-1", tokenDigest: "digest" }),
    ).rejects.toThrow(error);
  });
});

it("carries sender identity, marks actionable notifications high priority, and bounds UTF-8 payloads", async () => {
  const tokens = new MemoryPushTokenStore();
  await tokens.save("user-1", "ExponentPushToken[test]");
  const fetchMock = vi.fn(async () => jsonResponse({ data: { status: "ok" } }));
  vi.stubGlobal("fetch", fetchMock);
  await new ExpoPushProvider(tokens).send(
    {
      kind: "help",
      title: "Marketing",
      body: `x${"🔔".repeat(400)}`,
      botId: "bot",
      threadId: "thread",
      sender: { botId: "bot", name: "Head of Marketing", avatar: "a".repeat(2600) },
    },
    notifyContext,
  );
  const request = JSON.parse(
    String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body),
  );
  expect(request.data.sender).toEqual({
    botId: "bot",
    name: "Head of Marketing",
    avatar: "a".repeat(2600),
  });
  expect(request).toMatchObject({ mutableContent: true, priority: "high" });
  expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(3300);
  expect(request.body).toMatch(/^x(🔔)+…$/u);
  expect(Array.from(request.body as string)).toHaveLength(90);
});

it("uses data-only delivery only for Android builds that registered sender support", async () => {
  const tokens = new MemoryPushTokenStore();
  await tokens.save("user-1", "ExponentPushToken[test]", "", "android_sender");
  const fetchMock = vi.fn(async () => jsonResponse({ data: { status: "ok" } }));
  vi.stubGlobal("fetch", fetchMock);
  await new ExpoPushProvider(tokens).send(
    {
      kind: "completion",
      title: "Marketing",
      body: "Draft ready",
      botId: "bot",
      threadId: "thread",
      runId: "run",
      sender: { botId: "bot", name: "Marketing" },
      badge: 3,
    },
    notifyContext,
  );
  const request = JSON.parse(
    String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body),
  );
  expect(request).not.toHaveProperty("title");
  expect(request).not.toHaveProperty("body");
  expect(request).not.toHaveProperty("tag");
  expect(request.data).toMatchObject({
    notificationTitle: "Marketing",
    notificationBody: "Draft ready",
    notificationBadge: 3,
    runId: "run",
    sender: { botId: "bot", name: "Marketing" },
  });
  expect(request).not.toHaveProperty("priority");
});

it("carries the larger avatar only to devices without Android's 96px limit", async () => {
  const tokens = new MemoryPushTokenStore();
  await tokens.save("user-1", "ExponentPushToken[iphone]");
  const fetchMock = vi.fn(async () => jsonResponse({ data: { status: "ok" } }));
  vi.stubGlobal("fetch", fetchMock);
  await new ExpoPushProvider(tokens).send(
    {
      kind: "completion",
      title: "Marketing",
      body: "Draft ready",
      botId: "bot",
      threadId: "thread",
      sender: { botId: "bot", name: "Marketing", avatar: "small", avatarLarge: "large" },
    },
    notifyContext,
  );
  const request = JSON.parse(
    String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body),
  );
  expect(request.data.sender).toEqual({ botId: "bot", name: "Marketing", avatar: "large" });

  const androidTokens = new MemoryPushTokenStore();
  await androidTokens.save("user-2", "ExponentPushToken[droid]", "", "android_sender");
  const androidFetch = vi.fn(async () => jsonResponse({ data: { status: "ok" } }));
  fetchMock.mockImplementation(androidFetch);
  await new ExpoPushProvider(androidTokens).send(
    {
      kind: "completion",
      title: "Marketing",
      body: "Draft ready",
      botId: "bot",
      threadId: "thread",
      sender: { botId: "bot", name: "Marketing", avatar: "small", avatarLarge: "large" },
    },
    { ...notifyContext, userId: "user-2" },
  );
  const androidRequest = JSON.parse(
    String((fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit])[1].body),
  );
  expect(androidRequest.data.sender).toEqual({ botId: "bot", name: "Marketing", avatar: "small" });
});

it("falls back to the small avatar when no larger one fit the payload", async () => {
  const tokens = new MemoryPushTokenStore();
  await tokens.save("user-3", "ExponentPushToken[iphone]");
  const fetchMock = vi.fn(async () => jsonResponse({ data: { status: "ok" } }));
  vi.stubGlobal("fetch", fetchMock);
  await new ExpoPushProvider(tokens).send(
    {
      kind: "completion",
      title: "Marketing",
      body: "Draft ready",
      botId: "bot",
      threadId: "thread",
      sender: { botId: "bot", name: "Marketing", avatar: "small" },
    },
    { ...notifyContext, userId: "user-3" },
  );
  const request = JSON.parse(
    String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body),
  );
  expect(request.data.sender).toEqual({ botId: "bot", name: "Marketing", avatar: "small" });
});
