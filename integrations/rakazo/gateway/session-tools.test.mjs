import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionToolBroker } from "./session-tools.mjs";

test("only dispatches to the exact chief and space and settles through its lease", async () => {
  const broker = new SessionToolBroker();
  let frame;
  const close = broker.connect(
    "lease-a",
    { accountKey: "chief-a", spaceId: "space-a" },
    (value) => {
      frame = value;
    },
  );
  await assert.rejects(
    broker.call({
      chiefId: "chief-b",
      spaceId: "space-a",
      id: "x",
      tool: "paws_sessions_list",
      args: {},
    }),
    /web-client-unavailable/,
  );
  const pending = broker.call({
    chiefId: "chief-a",
    spaceId: "space-a",
    id: "x",
    tool: "paws_sessions_list",
    args: {},
  });
  assert.equal(frame.id, "x");
  assert.equal(broker.reply("lease-b", "x", { sessions: [] }), false);
  assert.equal(broker.reply("lease-a", "x", { sessions: [] }), true);
  assert.deepEqual(await pending, {
    sessions: [],
    connectionId: close.connectionId,
  });
  assert.equal(broker.reply("lease-a", "x", {}), false);
  close();
  broker.close();
});

test("never redispatches a mutation after disconnect; reconnect cannot steal its response", async () => {
  const broker = new SessionToolBroker();
  let count = 0;
  const identity = { accountKey: "chief", spaceId: "space" };
  const close = broker.connect("one", identity, () => count++);
  const call = {
    chiefId: "chief",
    spaceId: "space",
    id: "mutation",
    connectionId: close.connectionId,
    tool: "paws_session_send",
    args: { sessionId: "s", text: "hello" },
  };
  const pending = broker.call(call);
  close();
  await assert.rejects(pending, /outcome-unknown/);
  broker.connect("two", identity, () => count++);
  await assert.rejects(broker.call(call), /outcome-unknown/);
  assert.equal(count, 1);
  broker.close();
});

test("deduplicates concurrent calls, refuses changed args, isolates same request id across owners", async () => {
  const broker = new SessionToolBroker();
  let count = 0;
  const a = broker.connect(
    "a",
    { accountKey: "a", spaceId: "s" },
    () => count++,
  );
  const b = broker.connect(
    "b",
    { accountKey: "b", spaceId: "s" },
    () => count++,
  );
  const call = {
    chiefId: "a",
    spaceId: "s",
    id: "same",
    connectionId: a.connectionId,
    tool: "paws_session_send",
    args: { sessionId: "s", text: "x" },
  };
  const one = broker.call(call),
    two = broker.call(call);
  await assert.rejects(
    broker.call({ ...call, args: { sessionId: "s", text: "y" } }),
    /request-conflict/,
  );
  const other = broker.call({
    ...call,
    chiefId: "b",
    connectionId: b.connectionId,
  });
  broker.reply("a", "same", { accepted: true });
  broker.reply("b", "same", { accepted: true });
  await Promise.all([one, two, other]);
  assert.equal(count, 2);
  broker.close();
});

test("rejects unsupported tools and enforces capacity without evicting idempotency receipts", async () => {
  const broker = new SessionToolBroker({ maxEntries: 1 });
  const a = broker.connect("a", { accountKey: "a", spaceId: "s" }, () => {});
  await assert.rejects(
    broker.call({
      chiefId: "a",
      spaceId: "s",
      id: "bad",
      tool: "shell",
      args: {},
    }),
    /unsupported-tool/,
  );
  const p = broker.call({
    chiefId: "a",
    spaceId: "s",
    id: "one",
    connectionId: a.connectionId,
    tool: "paws_session_send",
    args: {},
  });
  broker.reply("a", "one", {});
  await p;
  await assert.rejects(
    broker.call({
      chiefId: "a",
      spaceId: "s",
      id: "two",
      tool: "paws_sessions_list",
      args: {},
    }),
    /capacity/,
  );
  broker.close();
});

test("HTTP bridge authenticates worker and browser separately and closes on lease revocation", async () => {
  const { createGateway } = await import("./server.mjs");
  const { GatewayState } = await import("./state.mjs");
  const { once } = await import("node:events");
  const state = new GatewayState();
  const config = {
    webUrl: new URL("http://127.0.0.1:9"),
    apiUrl: new URL("http://127.0.0.1:9"),
    publicOrigin: "https://bots.test",
    parentOrigins: ["https://paws.test"],
    bridgeSecret: "secret".repeat(8),
    identitySecret: "identity".repeat(8),
  };
  const { server } = createGateway(config, { state });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const launch = state.issue(
    { accountKey: "chief", spaceId: "space" },
    { parentOrigin: "https://paws.test", platform: "web" },
  );
  const lease = state.redeem(launch.ticket, "https://paws.test", "web");
  const headers = {
    origin: "https://paws.test",
    "x-paws-rakazo-session": lease.sessionKey,
  };
  const abort = new AbortController();
  let reader;
  try {
    const stream = await fetch(`${base}/api/paws-session-tools/stream`, {
      headers,
      signal: abort.signal,
    });
    assert.equal(stream.status, 200);
    reader = stream.body.getReader();
    await reader.read();
    assert.equal(
      (
        await fetch(`${base}/__paws/session-tools`, {
          method: "POST",
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/api/paws-session-tools/result`, {
          method: "POST",
          headers: { ...headers, origin: "https://evil.test" },
          body: "{}",
        })
      ).status,
      401,
    );
    const input = {
      id: "http-call",
      chiefId: "chief",
      spaceId: "space",
      tool: "paws_sessions_list",
      args: {},
    };
    const pending = fetch(`${base}/__paws/session-tools`, {
      method: "POST",
      headers: {
        "x-paws-bridge-secret": config.bridgeSecret,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    });
    const frame = new TextDecoder().decode((await reader.read()).value);
    assert.match(frame, /http-call/);
    const reply = await fetch(`${base}/api/paws-session-tools/result`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ id: input.id, result: { sessions: [] } }),
    });
    assert.deepEqual(await reply.json(), { accepted: true });
    const result = await (await pending).json();
    assert.deepEqual(result.result.sessions, []);
    assert.equal(typeof result.result.connectionId, "string");
    state.revoke(lease.sessionKey);
    await assert.rejects(async () => {
      while (!(await reader.read()).done) {}
      throw new Error("unexpected graceful end");
    });
  } finally {
    abort.abort();
    await reader?.cancel().catch(() => {});
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("disconnect releases completed receipts and old connection IDs cannot be rebound to a new tab", async () => {
  const broker = new SessionToolBroker({ maxEntries: 1 });
  const identity = { accountKey: "chief", spaceId: "space" };
  const a = broker.connect("a", identity, () => {});
  const input = {
    id: "once",
    chiefId: "chief",
    spaceId: "space",
    connectionId: a.connectionId,
    tool: "paws_session_send",
    args: { sessionId: "s", text: "private text" },
  };
  const pending = broker.call(input);
  broker.reply("a", "once", { accepted: true });
  await pending;
  const b = broker.connect(
    "b",
    { accountKey: "other", spaceId: "space" },
    () => {},
  );
  const other = broker.call({
    ...input,
    chiefId: "other",
    connectionId: b.connectionId,
  });
  broker.reply("b", "once", {});
  await other;
  assert.equal(broker.calls.size, 2);
  a();
  assert.equal(broker.calls.size, 1);
  const newA = broker.connect("new-a", identity, () => {});
  await assert.rejects(broker.call(input), /web-client-unavailable/);
  const next = broker.call({
    ...input,
    id: "new",
    connectionId: newA.connectionId,
  });
  broker.reply("new-a", "new", {});
  await next;
  broker.close();
  assert.equal(broker.calls.size, 0);
});

test("timeout retains an unknown write outcome without redispatch on the same connection", async () => {
  const broker = new SessionToolBroker({ timeoutMs: 5 });
  let sent = 0;
  const connection = broker.connect(
    "lease",
    { accountKey: "chief", spaceId: "space" },
    () => sent++,
  );
  const input = {
    chiefId: "chief",
    spaceId: "space",
    connectionId: connection.connectionId,
    id: "once",
    tool: "paws_session_send",
    args: { sessionId: "s", text: "x" },
  };
  await assert.rejects(broker.call(input), /timeout-outcome-unknown/);
  await assert.rejects(broker.call(input), /timeout-outcome-unknown/);
  assert.equal(sent, 1);
  broker.close();
});
