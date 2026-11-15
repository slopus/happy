import { USER_DEVICE_CONNECT_PATH } from "@rakazo/contracts";
import { secureHttpOrigin } from "@rakazo/contracts/network-host";
import WebSocket from "ws";
import type { HostComputerFrame } from "./host-computer-protocol.js";
import { HOST_COMPUTER_MAX_BYTES } from "./host-computer-protocol.js";
import type { HostComputerCall } from "./host-computer-runner.js";
import { createHostComputerRunner } from "./host-computer-runner.js";
import type { HostScreen } from "./host-screen.js";
import type { UserDeviceClientMessage, UserDeviceRevokeReason } from "./user-device-protocol.js";
import {
  USER_DEVICE_REVOKED_HEADER,
  userDeviceRevokeReason,
  userDeviceServerMessage,
} from "./user-device-protocol.js";

/** One frame or request plus its small envelope, in either direction. */
export const USER_DEVICE_MAX_MESSAGE_BYTES = HOST_COMPUTER_MAX_BYTES + 4096;
const PING_INTERVAL_MS = 30_000;
const BUSY_MESSAGE = "Local computer is busy. Try again shortly.";
const NOT_ALLOWED_MESSAGE = "Not allowed on this computer";

export interface UserDeviceClientOptions {
  serverUrl: string;
  token: string;
  root: string;
  /** Drives this computer's apps. Owned by the caller, which closes it. */
  screen?: HostScreen;
  /** The server revoked the device or rejected its token. The client has already stopped. */
  onRevoked: (reason?: UserDeviceRevokeReason) => void;
  /** Whether this computer lets the server's bots run anything. Asked before every request. */
  authorize: () => Promise<boolean>;
  retryMs?: { min: number; max: number };
}

/**
 * Connects outbound to a Rakazo server so its bots can use this computer. The server never
 * connects in. Runs only while started; `close` stops every command and the connection, and
 * `cancelAll` stops every command and refuses requests still waiting on `authorize`.
 */
export function startUserDeviceClient(options: UserDeviceClientOptions) {
  if (secureHttpOrigin(options.serverUrl) === null)
    throw new Error("Local computer access requires HTTPS or loopback");
  const retry = options.retryMs ?? { min: 1_000, max: 60_000 };
  const runner = createHostComputerRunner({ root: options.root, screen: options.screen });
  runner.setEnabled(true);
  const url = new URL(USER_DEVICE_CONNECT_PATH, options.serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  let stopped = false;
  let attempt = 0;
  let socket: WebSocket | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let refuseWaiting: (() => void) | undefined;

  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(reconnectTimer);
    runner.close();
    socket?.terminate();
  }

  function cancelAll() {
    if (stopped) return;
    refuseWaiting?.();
    runner.setEnabled(false);
    runner.setEnabled(true);
  }

  function revoked(reason?: UserDeviceRevokeReason) {
    if (stopped) return;
    stop();
    options.onRevoked(reason);
  }

  function scheduleReconnect() {
    if (stopped) return;
    // Full jitter keeps many devices from reconnecting in lockstep after a server restart.
    const ceiling = Math.min(retry.max, retry.min * 2 ** attempt);
    attempt += 1;
    reconnectTimer = setTimeout(connect, retry.min / 2 + Math.random() * ceiling);
    reconnectTimer.unref();
  }

  function connect() {
    if (stopped) return;
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${options.token}` },
      maxPayload: USER_DEVICE_MAX_MESSAGE_BYTES,
      handshakeTimeout: 15_000,
      followRedirects: false,
      perMessageDeflate: false,
    });
    socket = ws;
    const calls = new Map<
      string,
      { call: HostComputerCall; cancelled: boolean; settled: boolean }
    >();
    const authorizing = new Set<string>();
    let alive = true;
    let openedAt = 0;
    let ping: NodeJS.Timeout | undefined;
    refuseWaiting = () => {
      for (const id of authorizing)
        void send(id, { error: NOT_ALLOWED_MESSAGE }).catch(() => undefined);
      authorizing.clear();
    };

    ws.on("unexpected-response", (request, response) => {
      request.destroy();
      ws.terminate();
      if (response.statusCode === 401)
        revoked(
          userDeviceRevokeReason.safeParse(response.headers[USER_DEVICE_REVOKED_HEADER]).data,
        );
    });
    ws.on("open", () => {
      openedAt = Date.now();
      // A silent network drop otherwise leaves the device looking connected for hours.
      ping = setInterval(() => {
        if (!alive) {
          ws.terminate();
          return;
        }
        alive = false;
        ws.ping();
      }, PING_INTERVAL_MS);
      ping.unref();
    });
    ws.on("pong", () => {
      alive = true;
    });
    ws.on("error", () => {
      /* "close" follows and reconnects. */
    });
    ws.on("close", () => {
      clearInterval(ping);
      // A lost response is never retried, so in-flight work stops with the connection.
      for (const { call } of calls.values()) call.abort();
      calls.clear();
      if (socket === ws) {
        socket = undefined;
        refuseWaiting = undefined;
      }
      if (openedAt && Date.now() - openedAt >= PING_INTERVAL_MS) attempt = 0;
      scheduleReconnect();
    });
    ws.on("message", (data, isBinary) => {
      alive = true;
      if (isBinary) return;
      let message: ReturnType<typeof userDeviceServerMessage.parse>;
      try {
        const parsed = userDeviceServerMessage.safeParse(JSON.parse(data.toString()));
        if (!parsed.success) return;
        message = parsed.data;
      } catch {
        return;
      }
      if (message.type === "revoked") {
        revoked(message.reason);
        return;
      }
      if (message.type === "cancel") {
        authorizing.delete(message.id);
        const entry = calls.get(message.id);
        if (entry) {
          entry.cancelled = true;
          entry.call.abort();
        }
        return;
      }
      if (calls.has(message.id) || authorizing.has(message.id)) return;
      void handle(message.id, message.request);
    });

    function send(id: string, frame: HostComputerFrame<unknown>) {
      const entry = calls.get(id);
      let body = JSON.stringify({ type: "frame", id, frame } satisfies UserDeviceClientMessage);
      if (Buffer.byteLength(body) > USER_DEVICE_MAX_MESSAGE_BYTES) {
        frame = { error: "Local computer response is too large" };
        body = JSON.stringify({ type: "frame", id, frame } satisfies UserDeviceClientMessage);
        entry?.call.abort();
      }
      if (entry && ("done" in frame || "error" in frame)) entry.settled = true;
      return new Promise<void>((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) {
          reject(new Error("Local computer disconnected"));
          return;
        }
        ws.send(body, (error) => (error ? reject(error) : resolve()));
      });
    }

    async function handle(id: string, request: unknown) {
      authorizing.add(id);
      const allowed = await options.authorize().catch(() => false);
      if (!authorizing.delete(id) || socket !== ws) return;
      if (!allowed) {
        await send(id, { error: NOT_ALLOWED_MESSAGE }).catch(() => undefined);
        return;
      }
      const call = runner.begin();
      if (!call) {
        await send(id, { error: BUSY_MESSAGE }).catch(() => undefined);
        return;
      }
      const entry = { call, cancelled: false, settled: false };
      calls.set(id, entry);
      try {
        const outcome = await call.run(request, {
          open() {},
          write: (frame) => (call.signal.aborted ? undefined : send(id, frame)),
        });
        let refusal: string | undefined;
        if (outcome === "invalid") refusal = "Local computer request is invalid";
        else if (outcome === "busy") refusal = BUSY_MESSAGE;
        else if (outcome === "disabled" || call.signal.aborted)
          refusal = "Local computer operation stopped";
        if (refusal && !entry.cancelled && !entry.settled) await send(id, { error: refusal });
      } catch {
        /* The connection closed; the server fails the request. */
      } finally {
        call.end();
        if (calls.get(id) === entry) calls.delete(id);
      }
    }
  }

  connect();
  return { close: stop, cancelAll };
}

export type UserDeviceClient = ReturnType<typeof startUserDeviceClient>;
