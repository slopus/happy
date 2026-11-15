import type { Notification } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RealtimeListenerClient } from "./realtime.js";
import { PostgresRealtimeFanout } from "./realtime.js";

class FakeClient implements RealtimeListenerClient {
  readonly queries: string[] = [];
  ended = false;
  private readonly listeners = new Map<string, Set<(...args: never[]) => void>>();

  constructor(private readonly connectPromise: Promise<unknown> = Promise.resolve()) {}

  async connect() {
    return this.connectPromise;
  }

  async query(sql: string) {
    this.queries.push(sql);
  }

  async end() {
    this.ended = true;
  }

  on(event: string, listener: (...args: never[]) => void): this {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  removeAllListeners(): this {
    this.listeners.clear();
    return this;
  }

  notify(channel: string, payload: string) {
    this.emit("notification", { channel, payload } as Notification);
  }

  disconnect() {
    this.emit("end");
  }

  private emit(event: string, ...args: unknown[]) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      (listener as (...values: unknown[]) => void)(...args);
    }
  }
}

function setup(options: { reconnectBaseMs?: number } = {}) {
  const clients: FakeClient[] = [];
  const published: Array<{ sql: string; values: unknown[] }> = [];
  const realtime = new PostgresRealtimeFanout({
    connectionString: "postgres://unused",
    publisher: {
      query: async (sql, values) => {
        published.push({ sql, values });
      },
    },
    clientFactory: () => {
      const client = new FakeClient();
      clients.push(client);
      return client;
    },
    reconnectBaseMs: options.reconnectBaseMs,
    reconnectMaxMs: options.reconnectBaseMs,
    random: () => 0,
  });
  return { realtime, clients, published };
}

describe("PostgresRealtimeFanout", () => {
  afterEach(() => vi.useRealTimers());

  it("shares one fixed-channel listener across many logical subscribers", async () => {
    const { realtime, clients } = setup();
    const received = Array.from({ length: 200 }, () => vi.fn());
    const unsubscribers = await Promise.all(
      received.map((subscriber, index) =>
        realtime.subscribe(index % 2 === 0 ? "thread:a" : "thread:b", subscriber),
      ),
    );

    expect(clients).toHaveLength(1);
    await vi.waitFor(() => expect(clients[0]?.queries).toEqual(["LISTEN rakazo_events"]));
    received.forEach((subscriber) => {
      subscriber.mockClear();
    });
    clients[0]?.notify(
      "rakazo_events",
      JSON.stringify({ topic: "thread:a", payload: '{"cursor":3}' }),
    );
    expect(received.filter((subscriber) => subscriber.mock.calls.length > 0)).toHaveLength(100);

    clients[0]?.notify("rakazo_events", "malformed");
    clients[0]?.notify("another_channel", JSON.stringify({ topic: "thread:a", payload: "x" }));
    await Promise.all(unsubscribers.map((unsubscribe) => unsubscribe()));
    expect(clients[0]?.ended).toBe(false);
    await realtime.close();
    expect(clients[0]?.ended).toBe(true);
  });

  it("publishes a small envelope and rejects oversized signals", async () => {
    const { realtime, published } = setup();
    await realtime.publish("thread:a", "wake");
    expect(published[0]?.sql).toBe("SELECT pg_notify($1, $2)");
    expect(published[0]?.values[0]).toBe("rakazo_events");
    expect(JSON.parse(String(published[0]?.values[1] ?? "{}"))).toEqual({
      topic: "thread:a",
      payload: "wake",
    });
    await expect(realtime.publish("thread:a", "x".repeat(8_000))).rejects.toThrow("payload limit");
    await realtime.close();
  });

  it("reconnects one listener after a disconnect", async () => {
    vi.useFakeTimers();
    const { realtime, clients } = setup({ reconnectBaseMs: 1 });
    const received = vi.fn();
    await realtime.subscribe("thread:a", received);
    received.mockClear();
    clients[0]?.disconnect();
    await vi.advanceTimersByTimeAsync(1);
    expect(clients).toHaveLength(2);
    expect(received).toHaveBeenCalledWith("");
    received.mockClear();
    clients[1]?.notify(
      "rakazo_events",
      JSON.stringify({ topic: "thread:a", payload: "after-reconnect" }),
    );
    expect(received).toHaveBeenCalledWith("after-reconnect");
    await realtime.close();
  });

  it("does not block subscriptions or shutdown on a hung connection", async () => {
    const client = new FakeClient(new Promise(() => undefined));
    const realtime = new PostgresRealtimeFanout({
      connectionString: "postgres://unused",
      publisher: { query: async () => undefined },
      clientFactory: () => client,
    });

    const unsubscribe = await realtime.subscribe("thread:a", vi.fn());
    await unsubscribe();
    await realtime.close();
    expect(client.ended).toBe(true);
  });

  it("isolates subscriber errors and supports idempotent unsubscribe", async () => {
    const { realtime, clients } = setup();
    const healthy = vi.fn();
    const broken = await realtime.subscribe("thread:a", () => {
      throw new Error("broken subscriber");
    });
    const unsubscribe = await realtime.subscribe("thread:a", healthy);
    await Promise.resolve();
    clients[0]?.notify(
      "rakazo_events",
      JSON.stringify({ topic: "thread:a", payload: "still-delivered" }),
    );
    expect(healthy).toHaveBeenCalledWith("still-delivered");
    await broken();
    await unsubscribe();
    await unsubscribe();
    await realtime.close();
  });
});
