import { createHash, randomUUID } from "node:crypto";
/** Reverse RPC for the connected Paws Web host. No account credentials or durable plaintext. */
export const SESSION_TOOLS = new Set([
  "paws_sessions_list",
  "paws_session_read",
  "paws_session_send",
  "paws_session_resume",
  "paws_session_result",
]);
export class SessionToolBroker {
  constructor({ timeoutMs = 45_000, maxEntries = 1000 } = {}) {
    Object.assign(this, { timeoutMs, maxEntries });
    this.clients = new Map();
    this.calls = new Map();
  }
  connect(lease, identity, send) {
    if (this.clients.has(lease))
      throw new Error("web-client-already-connected");
    if (this.clients.size >= 100) throw new Error("web-client-capacity");
    const client = {
      lease,
      identity,
      send,
      connectionId: randomUUID(),
      count: 0,
    };
    this.clients.set(lease, client);
    const disconnect = () => {
      if (this.clients.get(lease) !== client) return;
      this.clients.delete(lease);
      for (const [key, call] of this.calls)
        if (call.client === client) {
          if (call.pending)
            call.fail(new Error("web-client-disconnected-outcome-unknown"));
          this.calls.delete(key);
        }
    };
    // Public routing nonce, never the bearer lease. Old nonce is unusable after disconnect.
    disconnect.connectionId = client.connectionId;
    return disconnect;
  }
  async call(input) {
    if (!SESSION_TOOLS.has(input.tool)) throw new Error("unsupported-tool");
    if (
      typeof input.id !== "string" ||
      !input.id ||
      input.id.length > 200 ||
      typeof input.chiefId !== "string" ||
      typeof input.spaceId !== "string" ||
      !input.args ||
      typeof input.args !== "object" ||
      Array.isArray(input.args)
    )
      throw new Error("invalid-request");
    const client = [...this.clients.values()]
      .reverse()
      .find(
        (c) =>
          c.identity.accountKey === input.chiefId &&
          c.identity.spaceId === input.spaceId &&
          (input.connectionId
            ? c.connectionId === input.connectionId
            : input.tool === "paws_sessions_list"),
      );
    if (!client) throw new Error("web-client-unavailable-outcome-unknown");
    const key = JSON.stringify([client.connectionId, input.id]);
    const signature = createHash("sha256")
      .update(JSON.stringify([input.tool, input.args]))
      .digest("hex");
    const previous = this.calls.get(key);
    if (previous) {
      if (previous.signature !== signature) throw new Error("request-conflict");
      return previous.promise;
    }
    if (
      client.count >= this.maxEntries ||
      [...this.calls.values()].filter((call) => call.pending).length >= 1000
    )
      throw new Error("request-capacity");
    client.count++;
    const call = { client, signature, pending: true };
    call.promise = new Promise((resolve, reject) => {
      const settle = (error, value) => {
        if (!call.pending) return;
        call.pending = false;
        clearTimeout(call.timer);
        if (
          !["paws_session_send", "paws_session_resume"].includes(input.tool)
        ) {
          this.calls.delete(key);
          client.count--;
        }
        error ? reject(error) : resolve(value);
      };
      call.fail = (error) => settle(error);
      call.resolve = (value) => settle(null, value);
      call.timer = setTimeout(
        () => call.fail(new Error("web-client-timeout-outcome-unknown")),
        this.timeoutMs,
      );
    });
    this.calls.set(key, call);
    try {
      client.send({ id: input.id, tool: input.tool, args: input.args });
    } catch {
      call.fail(new Error("web-client-disconnected-outcome-unknown"));
    }
    return call.promise;
  }
  reply(lease, id, result) {
    const client = this.clients.get(lease);
    if (!client) return false;
    const call = this.calls.get(JSON.stringify([client.connectionId, id]));
    if (!call?.pending || call.client !== client) return false;
    call.resolve({ ...result, connectionId: client.connectionId });
    return true;
  }
  close() {
    for (const call of this.calls.values())
      if (call.pending)
        call.fail(new Error("web-client-disconnected-outcome-unknown"));
    this.clients.clear();
    this.calls.clear();
  }
}
