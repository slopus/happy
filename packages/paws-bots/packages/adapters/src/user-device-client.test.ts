import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { USER_DEVICE_CONNECT_PATH } from "@rakazo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";
import type { UserDeviceClient } from "./user-device-client.js";
import { startUserDeviceClient, USER_DEVICE_MAX_MESSAGE_BYTES } from "./user-device-client.js";

const token = "device-token";
const nodeEnv: Record<string, string> = process.versions.electron
  ? { ELECTRON_RUN_AS_NODE: "1" }
  : {};

interface Frame {
  type: string;
  id: string;
  frame: Record<string, unknown>;
}

describe("user device client", () => {
  let root: string;
  let http: ReturnType<typeof createServer>;
  let wss: WebSocketServer;
  let serverUrl: string;
  let upgrades: IncomingMessage[];
  let reject401: boolean;
  let refusedBecause: string | undefined;
  let client: UserDeviceClient | undefined;
  let revoked: ReturnType<typeof vi.fn<(reason?: string) => void>>;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "rakazo-device-test-")));
    upgrades = [];
    reject401 = false;
    refusedBecause = undefined;
    revoked = vi.fn<(reason?: string) => void>();
    http = createServer();
    wss = new WebSocketServer({ noServer: true });
    http.on("upgrade", (request, socket, head) => {
      upgrades.push(request);
      if (
        reject401 ||
        request.url !== USER_DEVICE_CONNECT_PATH ||
        request.headers.authorization !== `Bearer ${token}`
      ) {
        const why = refusedBecause ? `x-rakazo-device-revoked: ${refusedBecause}\r\n` : "";
        socket.end(`HTTP/1.1 401 Unauthorized\r\n${why}Content-Length: 0\r\n\r\n`);
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        sockets.push(ws);
        wss.emit("connection", ws);
      });
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    serverUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    client?.close();
    client = undefined;
    for (const ws of wss.clients) ws.terminate();
    sockets.length = 0;
    wss.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  function start(authorize: () => Promise<boolean> = async () => true) {
    client = startUserDeviceClient({
      serverUrl,
      token,
      root,
      onRevoked: revoked,
      authorize,
      retryMs: { min: 20, max: 40 },
    });
  }
  async function connection(index = 0) {
    while (sockets.length <= index) await once(wss, "connection");
    return sockets[index]!;
  }
  function frames(ws: WebSocket) {
    const received: Frame[] = [];
    ws.on("message", (data) => received.push(JSON.parse(data.toString())));
    return received;
  }
  async function until(check: () => boolean) {
    await vi.waitFor(() => expect(check()).toBe(true), { timeout: 10_000, interval: 10 });
  }

  it("refuses cleartext non-loopback transport before connecting", () => {
    // Keep even the failing base-case reproduction on the local machine.
    const remote = new URL(serverUrl);
    remote.hostname = "0.0.0.0";
    serverUrl = remote.href;
    expect(() => start()).toThrow("Local computer access requires HTTPS or loopback");
    expect(upgrades).toHaveLength(0);
  });

  it("authenticates outbound and streams request frames back by id", async () => {
    start();
    const ws = await connection();
    expect(upgrades[0]!.headers.origin).toBeUndefined();
    const received = frames(ws);
    ws.send(
      JSON.stringify({ type: "request", id: "a", request: { method: "provision", botId: "bot" } }),
    );
    await until(() => received.some((frame) => frame.id === "a" && "done" in frame.frame));
    ws.send(
      JSON.stringify({
        type: "request",
        id: "b",
        request: {
          method: "execute",
          botId: "bot",
          command: { env: nodeEnv, argv: [process.execPath, "-e", "process.stdout.write('hi')"] },
        },
      }),
    );
    await until(() => received.some((frame) => frame.id === "b" && "done" in frame.frame));
    const values = received
      .filter((frame) => frame.id === "b" && "value" in frame.frame)
      .map((frame) => frame.frame.value);
    expect(values).toContainEqual({ type: "stdout", data: "hi" });
    expect(values.at(-1)).toMatchObject({ type: "exit", code: 0 });
  });

  it("stops a cancelled command without answering for it, and keeps serving", async () => {
    start();
    const ws = await connection();
    const received = frames(ws);
    ws.send(
      JSON.stringify({ type: "request", id: "p", request: { method: "provision", botId: "bot" } }),
    );
    await until(() => received.some((frame) => frame.id === "p" && "done" in frame.frame));
    ws.send(
      JSON.stringify({
        type: "request",
        id: "long",
        request: {
          method: "execute",
          botId: "bot",
          command: {
            env: nodeEnv,
            argv: [process.execPath, "-e", "console.log('started'); setInterval(() => {}, 1000)"],
          },
        },
      }),
    );
    await until(() =>
      received.some(
        (frame) =>
          frame.id === "long" && (frame.frame.value as { type?: string })?.type === "stdout",
      ),
    );
    ws.send(JSON.stringify({ type: "cancel", id: "long" }));
    ws.send(
      JSON.stringify({
        type: "request",
        id: "env",
        request: { method: "environment", botId: "x" },
      }),
    );
    await until(() => received.some((frame) => frame.id === "env" && "done" in frame.frame));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      received.some(
        (frame) => frame.id === "long" && ("done" in frame.frame || "error" in frame.frame),
      ),
    ).toBe(false);
  });

  it("asks before every request and refuses what this computer does not allow", async () => {
    let answer: (allowed: boolean) => void = () => undefined;
    const authorize = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)));
    start(authorize);
    const ws = await connection();
    const received = frames(ws);
    ws.send(
      JSON.stringify({ type: "request", id: "a", request: { method: "provision", botId: "bot" } }),
    );
    await until(() => authorize.mock.calls.length === 1);
    expect(received).toEqual([]);
    answer(false);
    await until(() => received.length === 1);
    expect(received[0]).toEqual({
      type: "frame",
      id: "a",
      frame: { error: "Not allowed on this computer" },
    });

    ws.send(
      JSON.stringify({ type: "request", id: "b", request: { method: "provision", botId: "bot" } }),
    );
    await until(() => authorize.mock.calls.length === 2);
    ws.send(JSON.stringify({ type: "cancel", id: "b" }));
    answer(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received.filter((frame) => frame.id === "b")).toEqual([]);
  });

  it("stops running commands and refuses waiting requests on cancelAll, and keeps serving", async () => {
    let answer: (allowed: boolean) => void = () => undefined;
    let ask = false;
    start(() =>
      ask ? new Promise<boolean>((resolve) => (answer = resolve)) : Promise.resolve(true),
    );
    const ws = await connection();
    const received = frames(ws);
    ws.send(
      JSON.stringify({ type: "request", id: "p", request: { method: "provision", botId: "bot" } }),
    );
    await until(() => received.some((frame) => frame.id === "p" && "done" in frame.frame));
    ws.send(
      JSON.stringify({
        type: "request",
        id: "long",
        request: {
          method: "execute",
          botId: "bot",
          command: {
            env: nodeEnv,
            argv: [process.execPath, "-e", "console.log('started'); setInterval(() => {}, 1000)"],
          },
        },
      }),
    );
    await until(() =>
      received.some(
        (frame) =>
          frame.id === "long" && (frame.frame.value as { type?: string })?.type === "stdout",
      ),
    );
    ask = true;
    ws.send(
      JSON.stringify({
        type: "request",
        id: "wait",
        request: { method: "provision", botId: "bot" },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    client!.cancelAll();
    await until(() => received.some((frame) => frame.id === "long" && "error" in frame.frame));
    await until(() => received.some((frame) => frame.id === "wait"));
    expect(received.find((frame) => frame.id === "wait")?.frame).toEqual({
      error: "Not allowed on this computer",
    });
    answer(true);
    ask = false;
    ws.send(
      JSON.stringify({
        type: "request",
        id: "env",
        request: { method: "environment", botId: "x" },
      }),
    );
    await until(() => received.some((frame) => frame.id === "env" && "done" in frame.frame));
    expect(received.filter((frame) => frame.id === "wait")).toHaveLength(1);
  });

  it("ignores malformed messages and refuses oversized ones by reconnecting", async () => {
    start();
    const ws = await connection();
    const received = frames(ws);
    ws.send("not json");
    ws.send(JSON.stringify({ type: "request", id: "x", request: { method: "rm", botId: "b" } }));
    ws.send("x".repeat(USER_DEVICE_MAX_MESSAGE_BYTES + 1));
    await connection(1);
    expect(received).toEqual([]);
    expect(revoked).not.toHaveBeenCalled();
  });

  it("reconnects after the connection drops, until closed", async () => {
    start();
    (await connection()).terminate();
    const second = await connection(1);
    client!.close();
    await once(second, "close");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(upgrades).toHaveLength(2);
  });

  it("stops for good when the server revokes the device", async () => {
    start();
    const ws = await connection();
    ws.send(JSON.stringify({ type: "revoked" }));
    await once(ws, "close");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(revoked).toHaveBeenCalledTimes(1);
    expect(revoked).toHaveBeenCalledWith(undefined);
    expect(upgrades).toHaveLength(1);
  });

  it("passes on that the sign-in which paired the device ended", async () => {
    start();
    const ws = await connection();
    ws.send(JSON.stringify({ type: "revoked", reason: "session-ended" }));
    await until(() => revoked.mock.calls.length === 1);
    expect(revoked).toHaveBeenCalledWith("session-ended");
  });

  it("treats a rejected token as revoked", async () => {
    reject401 = true;
    start();
    await until(() => revoked.mock.calls.length === 1);
    expect(revoked).toHaveBeenCalledWith(undefined);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(upgrades).toHaveLength(1);
  });

  it("passes on why a refused token was revoked, and only a reason it knows", async () => {
    reject401 = true;
    refusedBecause = "session-ended";
    start();
    await until(() => revoked.mock.calls.length === 1);
    expect(revoked).toHaveBeenCalledWith("session-ended");

    client!.close();
    refusedBecause = "something-else";
    start();
    await until(() => revoked.mock.calls.length === 2);
    expect(revoked).toHaveBeenLastCalledWith(undefined);
  });

  it("keeps quiet commands alive with heartbeat frames", async () => {
    start();
    const ws = await connection();
    const received = frames(ws);
    ws.send(
      JSON.stringify({ type: "request", id: "p", request: { method: "provision", botId: "bot" } }),
    );
    await until(() => received.some((frame) => frame.id === "p" && "done" in frame.frame));
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      ws.send(
        JSON.stringify({
          type: "request",
          id: "quiet",
          request: {
            method: "execute",
            botId: "bot",
            command: {
              env: nodeEnv,
              argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
            },
          },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      await vi.advanceTimersByTimeAsync(30_000);
      await until(() =>
        received.some((frame) => frame.id === "quiet" && frame.frame.heartbeat === true),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
