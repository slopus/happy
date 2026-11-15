import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { auditLogConfig, createAuditEventForwarder } from "./audit-forwarding.js";

const T0 = new Date("2026-10-30T12:00:00.000Z");

function event(id: string, minutesAgo: number) {
  return {
    id,
    createdAt: new Date(T0.getTime() - minutesAgo * 60_000),
    organizationId: "org-1",
    spaceId: "space-1",
    spaceName: "Acme",
    actorType: "bot",
    actorId: "bot-1",
    actorLabel: "Researcher",
    action: "tool.call",
    targetType: "tool",
    targetId: "gmail_send",
    targetLabel: "Gmail send",
    outcome: "success",
    runId: "run-1",
    threadId: "thread-1",
    ip: null,
    userAgent: null,
    metadata: {},
  };
}

function fakeDb(rows: ReturnType<typeof event>[]) {
  const state = {
    id: "default",
    lastCreatedAt: null as Date | null,
    lastEventId: null as string | null,
    failures: 0,
    nextAttemptAt: null as Date | null,
    updatedAt: T0,
  };
  const db = {
    state,
    auditEventForwarding: {
      upsert: vi.fn(async () => ({ ...state })),
      update: vi.fn(async ({ data }: { data: Partial<typeof state> }) =>
        Object.assign(state, data),
      ),
    },
    auditEvent: {
      findMany: vi.fn(async ({ where }: { where: { createdAt: { lt: Date }; OR?: unknown } }) =>
        rows.filter(
          (row) =>
            row.createdAt < where.createdAt.lt &&
            (!state.lastCreatedAt ||
              row.createdAt > state.lastCreatedAt ||
              (row.createdAt.getTime() === state.lastCreatedAt.getTime() &&
                row.id > state.lastEventId!)),
        ),
      ),
    },
  };
  return db;
}

beforeEach(() => {
  installLogger(
    createLogger({ service: "rakazo-worker", sinks: [createTestSink()], level: "debug" }),
  );
});

describe("audit event forwarding", () => {
  it("posts settled events as JSON Lines and moves the cursor past them", async () => {
    const db = fakeDb([event("a", 5), event("b", 3), event("c", 0)]);
    const fetch = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 202 }),
    );
    await createAuditEventForwarder(
      db as never,
      { url: "https://siem.example.test/ingest", authorization: "Bearer fake-token" },
      { fetch: fetch as typeof globalThis.fetch, now: () => T0 },
    )();

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://siem.example.test/ingest");
    expect(new Headers(init!.headers).get("authorization")).toBe("Bearer fake-token");
    const lines = String(init!.body)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    // The event from this minute may still have a slower commit behind it.
    expect(lines.map((line) => line.id)).toEqual(["a", "b"]);
    expect(lines[0]).toMatchObject({ action: "tool.call", actorLabel: "Researcher" });
    expect(db.state).toMatchObject({ lastEventId: "b", failures: 0, nextAttemptAt: null });
  });

  it("keeps the cursor and backs off when the receiver fails, then delivers on retry", async () => {
    const db = fakeDb([event("a", 5)]);
    let now = T0;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValue(new Response(null, { status: 200 }));
    const forward = createAuditEventForwarder(
      db as never,
      { url: "https://siem.example.test/ingest" },
      { fetch: fetch as typeof globalThis.fetch, now: () => now },
    );

    await forward();
    expect(db.state).toMatchObject({ lastEventId: null, failures: 1 });
    expect(db.state.nextAttemptAt).toEqual(new Date(T0.getTime() + 30_000));

    await forward();
    expect(fetch).toHaveBeenCalledTimes(1);

    now = new Date(T0.getTime() + 30_000);
    await forward();
    expect(db.state).toMatchObject({ lastEventId: null, failures: 2 });
    expect(db.state.nextAttemptAt).toEqual(new Date(now.getTime() + 60_000));

    now = new Date(now.getTime() + 60_000);
    await forward();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(db.state).toMatchObject({ lastEventId: "a", failures: 0, nextAttemptAt: null });
  });

  it("accepts only https receivers, except on this machine", () => {
    expect(() => auditLogConfig({ AUDIT_LOG_WEBHOOK_URL: "http://siem.example.test" })).toThrow(
      /https/,
    );
    expect(auditLogConfig({ AUDIT_LOG_WEBHOOK_URL: "http://127.0.0.1:9000/in" }).webhook).toEqual({
      url: "http://127.0.0.1:9000/in",
    });
    expect(auditLogConfig({ AUDIT_EVENT_RETENTION_DAYS: "30" })).toEqual({ retentionDays: 30 });
  });
});
