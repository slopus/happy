import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installAuditEventStore, listAuditEvents, recordAuditEvent } from "./audit-events.js";
import { recordSecurityEvent, withSecurityRequest } from "./security-events.js";

function fakeStore() {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    auditEvent: {
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        rows.push(...data);
        return { count: data.length };
      }),
    },
    space: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === "space-1" ? { organizationId: "org-1", name: "Acme" } : null,
      ),
    },
    user: {
      findUnique: vi.fn(async () => ({ email: "owner@example.test" })),
    },
    member: {
      findMany: vi.fn(async () => [{ organizationId: "org-1" }, { organizationId: "org-2" }]),
    },
  };
}

let sink: ReturnType<typeof createTestSink>;
let store: ReturnType<typeof fakeStore>;

beforeEach(() => {
  sink = createTestSink();
  installLogger(createLogger({ service: "rakazo-api", sinks: [sink], level: "debug" }));
  store = fakeStore();
  installAuditEventStore(store as never);
});

afterEach(() => installAuditEventStore(undefined));

describe("recordAuditEvent", () => {
  it("copies labels so the row reads the same after its space and bot are gone", async () => {
    await recordAuditEvent({
      action: "tool.call",
      actor: { type: "bot", id: "bot-1", label: "Researcher" },
      spaceId: "space-1",
      target: { type: "tool", id: "gmail_send", label: "Gmail send" },
      runId: "run-1",
      threadId: "thread-1",
      metadata: { effectId: "effect-1" },
    });
    expect(store.rows).toEqual([
      expect.objectContaining({
        organizationId: "org-1",
        spaceId: "space-1",
        spaceName: "Acme",
        actorType: "bot",
        actorId: "bot-1",
        actorLabel: "Researcher",
        action: "tool.call",
        targetLabel: "Gmail send",
        outcome: "success",
        runId: "run-1",
        threadId: "thread-1",
        metadata: { effectId: "effect-1" },
      }),
    ]);
  });

  it("names a member's use in the space, and a guest's account item use in theirs", async () => {
    // space-1 belongs to org-1; a guest owns org-own, made before org-later.
    const roles: Record<string, string | undefined> = { owner: "owner", guest: "guest" };
    Object.assign(store.member, {
      findUnique: vi.fn(
        async ({ where }: { where: { organizationId_userId: { userId: string } } }) => {
          const role = roles[where.organizationId_userId.userId];
          return role ? { role } : null;
        },
      ),
      findMany: vi.fn(async () => [
        { organizationId: "org-own", role: "owner" },
        { organizationId: "org-later", role: "owner" },
      ]),
    });
    const use = (userId: string, scope = "account") =>
      recordAuditEvent({
        action: "credential.used",
        actor: { type: "bot", id: "bot-1", label: "Researcher" },
        spaceId: "space-1",
        userId,
        target: { type: "vault_credential", id: "item-1", label: "chase-personal" },
        metadata: { scope, name: "chase-personal", site: "https://bank.example.test" },
      });
    const landed = () =>
      store.rows.splice(0).map((row) => [row.organizationId, row.targetLabel ?? "withheld"]);
    await use("owner");
    expect(landed()).toEqual([["org-1", "chase-personal"]]);
    // One whose membership is gone mid-write counts as a guest: an account item's use is unnamed
    // in the space's, and named, at the same time, in the oldest organization they own.
    for (const person of ["guest", "departed"]) {
      await use(person);
      const [inSpace, own] = store.rows;
      expect(inSpace?.createdAt).toEqual(own?.createdAt);
      expect(landed()).toEqual([
        ["org-1", "withheld"],
        ["org-own", "chase-personal"],
      ]);
      // A Space vault item's use stays in the space alone.
      await use(person, "space");
      expect(landed()).toEqual([["org-1", "withheld"]]);
    }
    // Owning none, the use stays in the space it happened in, unnamed, rather than being lost.
    store.member.findMany.mockResolvedValue([]);
    await use("guest");
    await use("departed");
    expect(landed()).toEqual([
      ["org-1", "withheld"],
      ["org-1", "withheld"],
    ]);
    expect(sink.events.filter((event) => event.level === "error")).toEqual([]);
  });

  it("records a user's caller and gives an account-wide event to each of their organizations", async () => {
    await withSecurityRequest({ ip: "203.0.113.5", userAgent: "Mozilla/5.0" }, () =>
      recordAuditEvent({ action: "auth.sign_in", actor: { type: "user", id: "user-1" } }),
    );
    expect(store.rows.map((row) => row.organizationId)).toEqual(["org-1", "org-2"]);
    expect(store.rows[0]).toMatchObject({
      actorLabel: "owner@example.test",
      ip: "203.0.113.5",
      userAgent: "Mozilla/5.0",
    });
  });

  it("keeps secret values and message content out of the row", async () => {
    await recordAuditEvent({
      action: "credential.changed",
      actor: { type: "user", id: "user-1" },
      spaceId: "space-1",
      metadata: {
        kind: "vault_credential",
        name: "GITHUB_TOKEN",
        secret: "ghp-secret-value",
        apiKey: "sk-test-value",
        message: "send the quarterly numbers",
        note: "Bearer fake-bearer-value",
      },
    });
    const stored = JSON.stringify(store.rows);
    for (const sensitive of ["ghp-secret-value", "sk-test-value", "quarterly", "fake-bearer"]) {
      expect(stored).not.toContain(sensitive);
    }
    expect(store.rows[0]?.metadata).toMatchObject({
      kind: "vault_credential",
      name: "GITHUB_TOKEN",
    });
  });

  it("never throws, and logs the event it could not store", async () => {
    store.auditEvent.createMany.mockRejectedValueOnce(new Error("connection reset"));
    await expect(
      recordAuditEvent({
        action: "space.deleted",
        actor: { type: "user", id: "user-1" },
        organizationId: "org-1",
        target: { type: "space", id: "space-9", label: "Old" },
      }),
    ).resolves.toBeUndefined();
    expect(sink.events.find((event) => event.message === "audit.event.write_failed")).toMatchObject(
      {
        level: "error",
        "audit.event.action": "space.deleted",
        "audit.event.actor": "user:user-1",
        "audit.event.target": "space:space-9",
      },
    );
  });
});

describe("security events in the audit log", () => {
  it("records an account's own security action in its organization", async () => {
    await recordSecurityEvent({
      type: "credential.deleted",
      userId: "user-1",
      spaceId: "space-1",
      metadata: { kind: "model", provider: "openrouter" },
    });
    expect(store.rows).toEqual([
      expect.objectContaining({
        organizationId: "org-1",
        action: "credential.deleted",
        actorType: "user",
        actorId: "user-1",
        targetType: "model",
      }),
    ]);
  });

  // Each vault event as its route or tool builds it; scope is undefined where an app that predates
  // Space overrides leaves it out of a save or a removal.
  const vaultEvents = {
    import: (scope?: "account" | "space") =>
      recordSecurityEvent({
        type: "credential.created",
        userId: "person",
        spaceId: "space-1",
        metadata: { procedure: "vault.import", kind: "vault_credential", scope },
      }),
    save: (scope?: "account" | "space") =>
      recordSecurityEvent({
        type: "credential.changed",
        userId: "person",
        spaceId: "space-1",
        metadata: {
          procedure: "vault.put",
          kind: "vault_credential",
          scope,
          name: "chase-personal",
        },
      }),
    remove: (scope?: "account" | "space") =>
      recordSecurityEvent({
        type: "credential.deleted",
        userId: "person",
        spaceId: "space-1",
        metadata: {
          procedure: "vault.remove",
          kind: "vault_credential",
          scope,
          name: "chase-personal",
        },
      }),
    reveal: (scope?: "account" | "space") =>
      recordSecurityEvent({
        type: "credential.revealed",
        userId: "person",
        spaceId: "space-1",
        metadata: {
          procedure: "vault.reveal",
          kind: "vault_credential",
          scope,
          name: "chase-personal",
        },
      }),
    use: (scope?: "account" | "space") =>
      recordAuditEvent({
        action: "credential.used",
        actor: { type: "bot", id: "bot-1", label: "Researcher" },
        spaceId: "space-1",
        userId: "person",
        target: { type: "vault_credential", id: "item-1", label: "chase-personal" },
        metadata: {
          tool: "browser_act",
          scope,
          name: "chase-personal",
          kind: "login",
          site: "https://bank.example.test",
        },
      }),
    // A command variable a shell command was sent with: a use that has no site.
    shell: (scope?: "account" | "space") =>
      recordAuditEvent({
        action: "credential.used",
        actor: { type: "bot", id: "bot-1", label: "Researcher" },
        spaceId: "space-1",
        userId: "person",
        target: { type: "vault_credential", id: "item-1", label: "chase-personal" },
        metadata: { tool: "shell", scope, name: "chase-personal", kind: "command" },
      }),
  };
  const uses = ["use", "shell"];
  // space-1 belongs to org-1, and the person's own organization is org-own. An account vault item
  // is its person's own; a Space vault item, or one whose vault isn't said, is recorded only in
  // the Space's organization, named there only for a full member of it.
  const N = "named";
  const W = "withheld";
  const both = [
    ["org-1", W],
    ["org-own", N],
  ];
  const matrix: [string, "account" | "space" | undefined, string[][], string[][]][] = [
    // Who acts, the item's vault, then the rows of an action of theirs (import, save, remove,
    // reveal) and of a bot's use in a run of theirs, on a site or in a shell.
    ["member", "account", [["org-1", W]], [["org-1", N]]],
    ["member owning an organization", "account", [["org-own", N]], [["org-1", N]]],
    ["member", "space", [["org-1", N]], [["org-1", N]]],
    ["member", undefined, [["org-1", N]], [["org-1", N]]],
    // An account vault action of their own happened in no space; a use did.
    ["guest owning an organization", "account", [["org-own", N]], both],
    // Nothing of a Space vault item reaches their own organization.
    ["guest owning an organization", "space", [["org-1", W]], [["org-1", W]]],
    ["guest owning an organization", undefined, [["org-1", W]], [["org-1", W]]],
    ["guest owning none", "account", [["org-1", W]], [["org-1", W]]],
    ["guest owning none", "space", [["org-1", W]], [["org-1", W]]],
    ["guest owning none", undefined, [["org-1", W]], [["org-1", W]]],
  ];
  it.each(
    matrix.flatMap(([who, scope, action, use]) =>
      Object.keys(vaultEvents).map((kind) => ({
        kind: kind as keyof typeof vaultEvents,
        who,
        scope,
        vault: scope ?? "unknown",
        rows: uses.includes(kind) ? use : action,
        lands: (uses.includes(kind) ? use : action).map((row) => row.join(" ")).join(", "),
      })),
    ),
  )(
    "$kind by a $who of an item in the $vault vault: $lands",
    async ({ kind, who, scope, rows }) => {
      Object.assign(store.member, {
        findUnique: vi.fn(async () => ({ role: who.startsWith("member") ? "member" : "guest" })),
        findMany: vi.fn(async () =>
          who.endsWith("owning an organization")
            ? [{ organizationId: "org-own", role: "owner" }]
            : [],
        ),
      });
      await vaultEvents[kind](scope);
      // Exactly these organizations: no row anywhere else.
      expect(store.rows.map((row) => row.organizationId)).toEqual(rows.map(([org]) => org));
      if (scope !== "account")
        expect(store.rows.filter((row) => row.organizationId !== "org-1")).toEqual([]);
      for (const [index, [org, named]] of rows.entries()) {
        const row = store.rows[index]!;
        const text = JSON.stringify(row);
        // The actor is kept either way.
        expect(row.actorType).toBe(uses.includes(kind) ? "bot" : "user");
        // The shared space's name stays out of the person's own organization.
        expect(row.spaceName).toBe(org === "org-own" ? null : "Acme");
        if (org === "org-own") expect(text).not.toContain("Acme");
        if (named === W) {
          // Nothing that names the item anywhere in the row: no target label, and of its metadata
          // only the kind, scope, tool and procedure.
          expect(row.targetLabel).toBeNull();
          for (const name of ["chase-personal", "bank.example.test"])
            expect(text).not.toContain(name);
          for (const key of Object.keys(row.metadata as object))
            expect(["procedure", "kind", "scope", "tool"]).toContain(key);
        } else {
          // An import's event never carries the login's name; a use names it and its site.
          if (kind !== "import") expect(text).toContain("chase-personal");
          if (uses.includes(kind)) expect(row).toMatchObject({ targetLabel: "chase-personal" });
          if (kind === "use") expect(text).toContain("bank.example.test");
        }
      }
      if (store.rows.length > 1) expect(store.rows[0]?.createdAt).toEqual(store.rows[1]?.createdAt);
    },
  );

  it("leaves deployment-wide signals out", async () => {
    await recordSecurityEvent({ type: "auth.sign_in.failed", ip: "203.0.113.5" });
    await recordSecurityEvent({ type: "rate_limit.hit", userId: "user-1", ip: "203.0.113.5" });
    await recordSecurityEvent({ type: "deployment.settings.changed", userId: "user-1" });
    expect(store.rows).toEqual([]);
  });
});

describe("listAuditEvents", () => {
  it("scopes every query to the organization and pages past the cursor", async () => {
    const createdAt = new Date("2026-10-30T10:00:00.000Z");
    const row = (id: string) => ({
      id,
      createdAt,
      organizationId: "org-1",
      spaceId: null,
      spaceName: null,
      actorType: "user",
      actorId: "user-1",
      actorLabel: null,
      action: "space.created",
      targetType: null,
      targetId: null,
      targetLabel: null,
      outcome: "success",
      runId: null,
      threadId: null,
      ip: null,
      userAgent: null,
      metadata: {},
    });
    const db = {
      auditEvent: {
        findFirst: vi.fn(async () => ({ id: "event-9", createdAt })),
        findMany: vi.fn(async (_args: unknown) => [row("event-8"), row("event-7"), row("event-6")]),
      },
    };
    const page = await listAuditEvents(db as never, "org-1", {
      cursor: "event-9",
      limit: 2,
      action: "space.created",
    });
    expect(page.events.map((event) => event.id)).toEqual(["event-8", "event-7"]);
    expect(page.nextCursor).toBe("event-7");
    expect(db.auditEvent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "event-9", organizationId: "org-1" } }),
    );
    const where = (db.auditEvent.findMany.mock.calls[0]![0] as { where: Record<string, unknown> })
      .where;
    expect(where).toMatchObject({ organizationId: "org-1", action: "space.created" });
  });
});
