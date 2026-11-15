import type { RealtimeFanout } from "@rakazo/adapter-kit";
import { DATABASE_KEEPALIVE } from "@rakazo/db";
import type { Notification } from "pg";
import { Client } from "pg";

const POSTGRES_CHANNEL = "rakazo_events";
const MAX_NOTIFY_PAYLOAD_BYTES = 7_900;

type Subscriber = (payload: string) => void;

export interface RealtimeListenerClient {
  connect(): Promise<unknown>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
  on(event: "notification", listener: (notification: Notification) => void): this;
  on(event: "error" | "end", listener: () => void): this;
  removeAllListeners(): this;
}

export interface PostgresRealtimeOptions {
  connectionString: string;
  publisher: {
    query(sql: string, values: unknown[]): Promise<unknown>;
  };
  clientFactory?: () => RealtimeListenerClient;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  random?: () => number;
}

export class PostgresRealtimeFanout implements RealtimeFanout {
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly clientFactory: () => RealtimeListenerClient;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly random: () => number;
  private client: RealtimeListenerClient | undefined;
  private connectingClient: RealtimeListenerClient | undefined;
  private connecting: Promise<void> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private closed = false;

  constructor(private readonly options: PostgresRealtimeOptions) {
    this.clientFactory =
      options.clientFactory ??
      (() =>
        new Client({
          connectionString: options.connectionString,
          application_name: "rakazo-realtime",
          connectionTimeoutMillis: 5_000,
          // An idle listener never writes, so without probes a failover leaves it deaf.
          ...DATABASE_KEEPALIVE,
        }) as RealtimeListenerClient);
    this.reconnectBaseMs = options.reconnectBaseMs ?? 250;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 10_000;
    this.random = options.random ?? Math.random;
  }

  describe() {
    return {
      id: "postgres",
      contractVersion: "1",
      adapterVersion: "0.2.0",
      capabilities: { distributed: true, push: true },
    };
  }

  async publish(topic: string, payload: string): Promise<void> {
    const envelope = JSON.stringify({ topic, payload });
    if (Buffer.byteLength(envelope, "utf8") > MAX_NOTIFY_PAYLOAD_BYTES) {
      throw new Error("Realtime signal exceeds the PostgreSQL NOTIFY payload limit");
    }
    await this.options.publisher.query("SELECT pg_notify($1, $2)", [POSTGRES_CHANNEL, envelope]);
  }

  async subscribe(topic: string, onMessage: Subscriber): Promise<() => Promise<void>> {
    if (this.closed) throw new Error("Realtime fanout is closed");
    const topicSubscribers = this.subscribers.get(topic) ?? new Set<Subscriber>();
    topicSubscribers.add(onMessage);
    this.subscribers.set(topic, topicSubscribers);
    void this.ensureConnected().catch(() => undefined);

    let subscribed = true;
    return async () => {
      if (!subscribed) return;
      subscribed = false;
      const current = this.subscribers.get(topic);
      current?.delete(onMessage);
      if (current?.size === 0) this.subscribers.delete(topic);
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.subscribers.clear();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const connectingClient = this.connectingClient;
    this.connectingClient = undefined;
    if (connectingClient) await this.disposeClient(connectingClient);
    const client = this.client;
    this.client = undefined;
    if (client) await this.disposeClient(client);
  }

  private async ensureConnected(): Promise<void> {
    if (this.closed || this.client || this.subscribers.size === 0) return;
    if (!this.connecting) {
      this.connecting = this.connectClient().finally(() => {
        this.connecting = undefined;
        if (!this.closed && this.subscribers.size > 0 && !this.client) this.scheduleReconnect();
      });
    }
    await this.connecting;
  }

  private async connectClient(): Promise<void> {
    const candidate = this.clientFactory();
    this.connectingClient = candidate;
    const disconnected = () => this.handleDisconnect(candidate);
    candidate.on("notification", (notification) => this.handleNotification(notification));
    candidate.on("error", disconnected);
    candidate.on("end", disconnected);
    try {
      await candidate.connect();
      await candidate.query(`LISTEN ${POSTGRES_CHANNEL}`);
      if (this.closed || this.subscribers.size === 0 || this.connectingClient !== candidate) {
        await this.disposeClient(candidate);
        return;
      }
      this.connectingClient = undefined;
      this.client = candidate;
      this.reconnectAttempt = 0;
      this.notifySubscribersToCatchUp();
    } catch (error) {
      if (this.connectingClient === candidate) this.connectingClient = undefined;
      await this.disposeClient(candidate);
      throw error;
    }
  }

  private handleNotification(notification: Notification): void {
    if (notification.channel !== POSTGRES_CHANNEL || !notification.payload) return;
    try {
      const envelope = JSON.parse(notification.payload) as { topic?: unknown; payload?: unknown };
      if (typeof envelope.topic !== "string" || typeof envelope.payload !== "string") return;
      const subscribers = this.subscribers.get(envelope.topic);
      if (!subscribers) return;
      this.notifySubscribers(subscribers, envelope.payload);
    } catch {
      // Ignore malformed signals. Durable events remain in the database.
    }
  }

  private notifySubscribersToCatchUp(): void {
    for (const subscribers of this.subscribers.values()) {
      this.notifySubscribers(subscribers, "");
    }
  }

  private notifySubscribers(subscribers: Iterable<Subscriber>, payload: string): void {
    for (const subscriber of [...subscribers]) {
      try {
        subscriber(payload);
      } catch {
        // One broken local subscriber must not block the others.
      }
    }
  }

  private handleDisconnect(candidate: RealtimeListenerClient): void {
    if (candidate === this.connectingClient) this.connectingClient = undefined;
    else if (candidate === this.client) this.client = undefined;
    else return;
    void this.disposeClient(candidate);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.subscribers.size === 0 || this.reconnectTimer) return;
    const exponential = Math.min(
      this.reconnectMaxMs,
      this.reconnectBaseMs * 2 ** this.reconnectAttempt,
    );
    this.reconnectAttempt += 1;
    const delay = Math.max(1, Math.round(exponential * (0.75 + this.random() * 0.5)));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.ensureConnected().catch(() => undefined);
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async disposeClient(client: RealtimeListenerClient): Promise<void> {
    client.removeAllListeners();
    await client.end().catch(() => undefined);
  }
}

export class InMemoryRealtimeFanout implements RealtimeFanout {
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private closed = false;

  describe() {
    return {
      id: "memory",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { distributed: false, push: true },
    };
  }

  async publish(topic: string, payload: string): Promise<void> {
    if (this.closed) return;
    for (const subscriber of [...(this.subscribers.get(topic) ?? [])]) subscriber(payload);
  }

  async subscribe(topic: string, onMessage: Subscriber): Promise<() => Promise<void>> {
    if (this.closed) throw new Error("Realtime fanout is closed");
    const topicSubscribers = this.subscribers.get(topic) ?? new Set<Subscriber>();
    topicSubscribers.add(onMessage);
    this.subscribers.set(topic, topicSubscribers);
    let subscribed = true;
    return async () => {
      if (!subscribed) return;
      subscribed = false;
      const current = this.subscribers.get(topic);
      current?.delete(onMessage);
      if (current?.size === 0) this.subscribers.delete(topic);
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.subscribers.clear();
  }
}
