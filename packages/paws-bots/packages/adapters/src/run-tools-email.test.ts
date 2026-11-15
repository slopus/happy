import {
  toolRequiresApproval,
  toolRequiresExplicitApproval,
  toolResultTaintsRun,
} from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { botEmailInstruction } from "./run-instructions.js";
import { selectBuiltinToolsForRun } from "./run-tool-selection.js";
import { emailTools } from "./run-tools-email.js";

type Row = {
  id: string;
  botId: string;
  fromAddress: string;
  fromName: string;
  verified: boolean;
  sent: boolean;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  attachments: unknown[];
  receivedAt: Date;
  /** Blind-index tokens: the row is encrypted, so its stored fields match no substring. */
  searchTokens?: number[];
};

function row(overrides: Partial<Row>): Row {
  return {
    id: "email-1",
    botId: "bot-1",
    fromAddress: "noreply@shop.test",
    fromName: "Shop",
    verified: false,
    sent: false,
    to: ["scout@bots.test"],
    cc: [],
    subject: "Your code",
    text: "Your sign-in code is 123456.",
    attachments: [],
    receivedAt: new Date("2026-11-05T10:00:00.000Z"),
    ...overrides,
  };
}

function fakeRun(
  rows: Row[],
  options: {
    runUserId?: string;
    arriving?: Row;
    secrets?: string[];
    /** The Space's query tokens per key version, as content encryption returns them. */
    queryTokens?: number[][];
  } = {},
) {
  const inbox = [...rows];
  let listed = 0;
  const copyEarlierFiles = vi.fn();
  const matches = (email: Row, where: Record<string, unknown>) => {
    const since = (where.receivedAt as { gt?: Date } | undefined)?.gt;
    const before = (where.receivedAt as { lt?: Date } | undefined)?.lt;
    const or = where.OR as
      | Array<Record<string, { contains?: string; hasEvery?: number[] }>>
      | undefined;
    const matchesClause = ([field, test]: [string, { contains?: string; hasEvery?: number[] }]) =>
      test.hasEvery
        ? test.hasEvery.every((token) => email.searchTokens?.includes(token))
        : !email.searchTokens &&
          String(email[field as keyof Row])
            .toLowerCase()
            .includes(test.contains!.toLowerCase());
    return (
      email.botId === where.botId &&
      (!since || email.receivedAt > since) &&
      (!before || email.receivedAt < before) &&
      (!or || or.some((clause) => Object.entries(clause).some(matchesClause)))
    );
  };
  const ctx = {
    deps: {
      prisma: {
        ...(options.queryTokens
          ? {
              $contentEncryption: () => ({
                messageSearchTokens: async () => options.queryTokens,
              }),
            }
          : {}),
        botEmailMessage: {
          findFirst: async ({ where }: { where: { id: string; botId: string } }) =>
            inbox.find((email) => email.id === where.id && email.botId === where.botId) ?? null,
          findMany: async ({
            where,
            take,
            orderBy,
          }: {
            where: Record<string, unknown>;
            take?: number;
            orderBy: { receivedAt: "asc" | "desc" };
          }) => {
            listed += 1;
            // Mail that arrives while the bot waits shows up on the second look.
            if (listed === 2 && options.arriving) inbox.push(options.arriving);
            return inbox
              .filter((email) => matches(email, where))
              .sort(
                (a, b) =>
                  (orderBy.receivedAt === "asc" ? 1 : -1) *
                  (a.receivedAt.getTime() - b.receivedAt.getTime()),
              )
              .slice(0, take);
          },
          deleteMany: async ({
            where,
          }: {
            where: { id: { in: string[] }; botId: string; sent: boolean };
          }) => {
            const gone = inbox.filter(
              (email) =>
                where.id.in.includes(email.id) &&
                email.botId === where.botId &&
                email.sent === where.sent,
            );
            for (const email of gone) inbox.splice(inbox.indexOf(email), 1);
            return { count: gone.length };
          },
        },
      },
    },
    bot: { id: "bot-1", userId: "owner-1" },
    run: { userId: options.runUserId ?? "owner-1" },
    computer: { copyEarlierFiles },
    context: { signal: new AbortController().signal },
    secrets: options.secrets ?? [],
  };
  const invoke = (name: "read_email" | "delete_email", args: Record<string, unknown>) =>
    emailTools[name]!(
      ctx as never,
      {
        name,
        args,
        executionId: "call-1",
        finish: async (result: unknown) => result,
      } as never,
    ) as Promise<Record<string, unknown>>;
  const call = (args: Record<string, unknown>) => invoke("read_email", args);
  const remove = (args: Record<string, unknown>) => invoke("delete_email", args);
  return { call, remove, inbox, copyEarlierFiles };
}

describe("read_email", () => {
  it("lists the newest mail as untrusted data", async () => {
    const { call } = fakeRun([
      row({ id: "old", receivedAt: new Date("2026-11-01T00:00:00.000Z"), subject: "Old" }),
      row({ id: "new", text: `Code 999.\n\n${"x".repeat(500)}` }),
      row({ id: "elsewhere", botId: "bot-2" }),
    ]);

    const result = await call({});

    expect(result.untrusted).toBe(true);
    expect(result.nextSince).toBe("2026-11-05T10:00:00.000Z");
    expect(result.emails).toEqual([
      expect.objectContaining({ id: "new", from: "Shop <noreply@shop.test>", verified: false }),
      expect.objectContaining({ id: "old", subject: "Old" }),
    ]);
    const preview = (result.emails as Array<{ preview: string }>)[0]?.preview ?? "";
    expect(preview.startsWith("Code 999. xxx")).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(160);
  });

  it("finds mail by words in it and by when it arrived", async () => {
    const { call } = fakeRun([
      row({ id: "receipt", subject: "Receipt #42", receivedAt: new Date("2026-11-04") }),
      row({ id: "code", subject: "Your code", receivedAt: new Date("2026-11-05") }),
    ]);

    expect(((await call({ query: "receipt" })).emails as unknown[]).length).toBe(1);
    expect(
      ((await call({ since: "2026-11-04T12:00:00.000Z" })).emails as Array<{ id: string }>).map(
        (email) => email.id,
      ),
    ).toEqual(["code"]);
  });

  it("finds encrypted mail by its blind index and checks it once decrypted", async () => {
    const ids = async (query: string, queryTokens: number[][]) => {
      const { call } = fakeRun(
        [
          row({ id: "sealed-hit", subject: "Pelican report", searchTokens: [7, 9] }),
          // Shares the query's tokens without containing it: a hash collision.
          row({ id: "sealed-miss", subject: "Other news", searchTokens: [7, 9] }),
          row({ id: "plain-hit", text: "About the pelican" }),
          row({ id: "plain-miss", text: "Nothing here" }),
        ],
        { queryTokens },
      );
      return ((await call({ query })).emails as Array<{ id: string }>).map((email) => email.id);
    };

    expect((await ids("pelican", [[7]])).sort()).toEqual(["plain-hit", "sealed-hit"]);
    // Too short to be indexed: the newest mail is checked directly.
    expect((await ids("a", [[]])).sort()).toEqual(["plain-hit", "sealed-hit"]);
  });

  it("moves past new mail a search checked and dropped", async () => {
    const checked = new Date("2026-11-02T00:00:00.000Z");
    const { call } = fakeRun(
      [row({ id: "sealed-miss", subject: "Other news", searchTokens: [7], receivedAt: checked })],
      { queryTokens: [[7]] },
    );

    const first = await call({ since: "2026-11-01T00:00:00.000Z", query: "pelican" });

    expect(first.emails).toEqual([]);
    expect(first.nextSince).toBe(checked.toISOString());
  });

  it("starts the next look after the newest email it returned, or where it was asked to", async () => {
    const { call } = fakeRun([], { arriving: row({ id: "late", receivedAt: new Date() }) });

    const waited = await call({ waitSeconds: 10 });
    const again = await call({ since: waited.nextSince });

    expect(waited.emails).toEqual([expect.objectContaining({ id: "late" })]);
    expect(again.emails).toEqual([]);
    expect(again.nextSince).toBe(waited.nextSince);
  });

  it("reads every new email in order by following nextSince", async () => {
    const { call } = fakeRun([
      row({ id: "a", receivedAt: new Date("2026-11-01T00:00:00.000Z") }),
      row({ id: "b", receivedAt: new Date("2026-11-02T00:00:00.000Z") }),
      row({ id: "c", receivedAt: new Date("2026-11-03T00:00:00.000Z") }),
    ]);

    const first = await call({ since: "2026-10-31T00:00:00.000Z", limit: 2 });
    const rest = await call({ since: first.nextSince, limit: 2 });

    expect((first.emails as Array<{ id: string }>).map((email) => email.id)).toEqual(["a", "b"]);
    expect((rest.emails as Array<{ id: string }>).map((email) => email.id)).toEqual(["c"]);
  });

  it("pages back to older mail", async () => {
    const { call } = fakeRun([
      row({ id: "a", receivedAt: new Date("2026-11-01T00:00:00.000Z") }),
      row({ id: "b", receivedAt: new Date("2026-11-02T00:00:00.000Z") }),
      row({ id: "c", receivedAt: new Date("2026-11-03T00:00:00.000Z") }),
    ]);

    const first = (await call({ limit: 2 })).emails as Array<{ id: string; receivedAt: string }>;
    const older = (await call({ limit: 2, before: first.at(-1)?.receivedAt })).emails;

    expect(first.map((email) => email.id)).toEqual(["c", "b"]);
    expect(older).toEqual([expect.objectContaining({ id: "a" })]);
  });

  it("masks secrets the bot holds when an email repeats them", async () => {
    const { call } = fakeRun(
      [row({ id: "email-1", subject: "pw hunter22", text: "Your password is hunter22" })],
      {
        secrets: ["hunter22"],
      },
    );

    const listed = JSON.stringify(await call({}));
    const read = JSON.stringify(await call({ id: "email-1" }));

    expect(listed).not.toContain("hunter22");
    expect(read).not.toContain("hunter22");
    expect(read).toContain("Your password is");
  });

  it("masks a secret that a page break or the preview would cut in two", async () => {
    const secret = "correct-horse-battery";
    const text = `${"x".repeat(7_990)}${secret} end`;
    const { call } = fakeRun(
      [row({ id: "email-1", text: `${"y".repeat(150)}${secret}` }), row({ id: "email-2", text })],
      {
        secrets: [secret],
      },
    );

    const listed = JSON.stringify(await call({}));
    const first = (await call({ id: "email-2" })).email as { nextTextOffset: number };
    const rest = JSON.stringify(await call({ id: "email-2", textOffset: first.nextTextOffset }));

    expect(listed).not.toContain("correct-horse");
    expect(JSON.stringify(first)).not.toContain("correct");
    expect(rest).not.toContain("battery");
  });

  it("waits for a matching email to arrive", async () => {
    const { call } = fakeRun([], { arriving: row({ id: "late", receivedAt: new Date() }) });

    const result = await call({ query: "code", waitSeconds: 10 });

    expect(result.emails).toEqual([expect.objectContaining({ id: "late" })]);
  });

  it("waits a wait shorter than one poll", async () => {
    const { call } = fakeRun([], { arriving: row({ id: "late", receivedAt: new Date() }) });

    const result = await call({ waitSeconds: 1 });

    expect(result.emails).toEqual([expect.objectContaining({ id: "late" })]);
  });

  it("reads one email whole, a page at a time, and copies its files", async () => {
    const { call, copyEarlierFiles } = fakeRun([
      row({
        text: "a".repeat(10_000),
        attachments: [
          { artifactId: "art-1", name: "invoice.pdf", mimeType: "application/pdf", size: 3 },
          { name: "setup.exe" },
        ],
      }),
    ]);

    const first = (await call({ id: "email-1" })).email as Record<string, unknown>;
    const rest = (await call({ id: "email-1", textOffset: first.nextTextOffset })).email as Record<
      string,
      unknown
    >;

    expect(first).toMatchObject({
      from: "Shop <noreply@shop.test>",
      verified: false,
      nextTextOffset: 8_000,
      files: [
        { name: "invoice.pdf", path: "attachments/art-1.pdf" },
        { name: "setup.exe", unavailable: true },
      ],
    });
    expect(String(first.text)).toHaveLength(8_000);
    expect(String(rest.text)).toHaveLength(2_000);
    expect(rest.nextTextOffset).toBeUndefined();
    expect(copyEarlierFiles).toHaveBeenCalledWith([
      expect.objectContaining({ kind: "file", artifactId: "art-1", name: "invoice.pdf" }),
    ]);
  });

  it("reads only this bot's mail, and only in its owner's runs", async () => {
    const mine = fakeRun([row({ id: "theirs", botId: "bot-2" })]);
    const visitor = fakeRun([row({})], { runUserId: "visitor-1" });

    expect(await mine.call({ id: "theirs" })).toEqual({
      error: "No email with that id in your inbox.",
    });
    expect(await visitor.call({})).toEqual({ error: "Only the bot's owner can do that." });
  });

  it("is offered only where the inbox may be read, and needs no approval to read", () => {
    const names = (emailInbox: boolean) =>
      selectBuiltinToolsForRun({
        graphicalToolsAllowed: false,
        groupId: null,
        trigger: "webhook",
        semanticMemoryEnabled: false,
        messagingChannelRun: false,
        emailInbox,
      }).map((tool) => tool.name);

    expect(names(true)).toContain("read_email");
    expect(names(false)).not.toContain("read_email");
    // What it returns is someone else's mail, so the run counts as having read outside content.
    expect(toolResultTaintsRun("read_email")).toBe(true);
  });
});

describe("delete_email", () => {
  it("deletes only mail this bot received", async () => {
    const { remove, inbox } = fakeRun([
      row({ id: "spam" }),
      row({ id: "kept" }),
      row({ id: "theirs", botId: "bot-2" }),
      row({ id: "outgoing", sent: true }),
    ]);

    expect(await remove({ ids: ["spam", "spam", "theirs", "outgoing", "missing"] })).toEqual({
      deleted: 1,
    });
    expect(inbox.map((email) => email.id)).toEqual(["kept", "theirs", "outgoing"]);
  });

  it("works only in its owner's runs, for a bounded list of ids", async () => {
    const visitor = fakeRun([row({})], { runUserId: "visitor-1" });
    const owner = fakeRun([row({})]);

    expect(await visitor.remove({ ids: ["email-1"] })).toEqual({
      error: "Only the bot's owner can do that.",
    });
    expect(visitor.inbox).toHaveLength(1);
    expect(await owner.remove({ ids: [] })).toHaveProperty("error");
    expect(
      await owner.remove({ ids: Array.from({ length: 51 }, (_, index) => `e${index}`) }),
    ).toHaveProperty("error");
  });

  it("is offered with the inbox and follows the owner's approval settings", () => {
    const names = (emailInbox: boolean) =>
      selectBuiltinToolsForRun({
        graphicalToolsAllowed: false,
        groupId: null,
        trigger: "user",
        semanticMemoryEnabled: false,
        messagingChannelRun: false,
        emailInbox,
      }).map((tool) => tool.name);

    expect(names(true)).toContain("delete_email");
    expect(names(false)).not.toContain("delete_email");
    expect(toolRequiresApproval("delete_email", false)).toBe(true);
    expect(toolResultTaintsRun("delete_email")).toBe(false);
  });
});

describe("botEmailInstruction", () => {
  it("names only the inbox tools the run has", () => {
    const all = botEmailInstruction("scout@bots.test", { read: true, send: true, delete: true });
    const readOnly = botEmailInstruction("scout@bots.test", {
      read: true,
      send: false,
      delete: false,
    });

    for (const tool of ["read_email", "send_email", "delete_email"]) expect(all).toContain(tool);
    expect(readOnly).toContain("read_email");
    expect(readOnly).not.toContain("send_email");
    expect(readOnly).not.toContain("delete_email");
    expect(
      botEmailInstruction("scout@bots.test", { read: false, send: false, delete: false }),
    ).toBe("Your email address is scout@bots.test.");
  });
});

describe("claim_email_address", () => {
  function claimRun(
    options: {
      claimed?: Record<string, string>;
      domain?: string;
      runUserId?: string;
      raceTo?: string;
      tainted?: boolean;
      approved?: boolean;
    } = {},
  ) {
    // name → botId, as bot_email_addresses keeps them.
    const names = new Map(Object.entries(options.claimed ?? {}));
    const ctx = {
      deps: {
        inboundEmailDomain: "domain" in options ? options.domain : "bots.test",
        prisma: {
          // This is the run's first attempt.
          attempt: { count: async () => 1 },
          botEmailAddress: {
            findUnique: async ({ where }: { where: { botId?: string; name?: string } }) => {
              if (where.name) {
                const botId = names.get(where.name);
                return botId ? { botId, name: where.name } : null;
              }
              const entry = [...names].find(([, botId]) => botId === where.botId);
              return entry ? { name: entry[0], botId: entry[1] } : null;
            },
            create: async ({ data }: { data: { name: string; botId: string } }) => {
              if (options.raceTo) names.set(options.raceTo, data.botId);
              if (options.raceTo || names.has(data.name))
                throw Object.assign(new Error("taken"), { code: "P2002" });
              names.set(data.name, data.botId);
              return data;
            },
          },
        },
      },
      bot: { id: "bot-1", userId: "owner-1" },
      run: { userId: options.runUserId ?? "owner-1" },
      state: { tainted: Boolean(options.tainted) },
      runId: "run-1",
      trust: { receivedOutsideMessage: async () => false },
    };
    const call = (args: Record<string, unknown>) =>
      emailTools.claim_email_address!(
        ctx as never,
        {
          name: "claim_email_address",
          args,
          executionId: "c",
          nextApprovedTool: options.approved ? "claim_email_address" : undefined,
          finish: async (r: unknown) => r,
        } as never,
      ) as Promise<Record<string, unknown>>;
    return { call, names };
  }

  it("claims the name the owner agreed to, for good", async () => {
    const { call, names } = claimRun();

    expect(await call({ name: " Scout " })).toEqual({ address: "scout@bots.test" });
    expect(names.get("scout")).toBe("bot-1");
    expect(await call({ name: "other" })).toEqual({
      error: "You already have an address, and it can't change.",
      address: "scout@bots.test",
    });
  });

  it("claims after outside content only when the owner approved this call", async () => {
    const steered = claimRun({ tainted: true });
    const approved = claimRun({ tainted: true, approved: true });

    expect((await steered.call({ name: "scout" })).error).toContain("read outside content");
    expect(steered.names.size).toBe(0);
    expect(await approved.call({ name: "scout" })).toEqual({ address: "scout@bots.test" });
  });

  it("tells a claim that lost a race to another name what the bot got", async () => {
    // Another claim for this bot, with another name, lands first.
    const { call } = claimRun({ raceTo: "raced" });

    expect(await call({ name: "scout" })).toEqual({
      error: "You already have an address, and it can't change.",
      address: "raced@bots.test",
    });
  });

  it("refuses taken, reserved and malformed names, and anyone but the owner", async () => {
    const { call } = claimRun({ claimed: { scout: "bot-2" } });

    expect(await call({ name: "scout" })).toEqual({
      error: "That address isn't available. Ask for another.",
    });
    expect((await call({ name: "postmaster" })).error).toBe("That address isn't available");
    expect((await call({ name: "a" })).error).toEqual(expect.any(String));
    expect(await claimRun({ runUserId: "visitor-1" }).call({ name: "x1" })).toEqual({
      error: "Only the bot's owner can do that.",
    });
    expect(await claimRun({ domain: undefined }).call({ name: "x1" })).toEqual({
      error: "This server doesn't receive email.",
    });
  });

  it("is offered only to the owner's own chat before the bot has an address, and always asks", () => {
    const names = (options: { trigger: string; groupId?: string; emailClaimable: boolean }) =>
      selectBuiltinToolsForRun({
        graphicalToolsAllowed: false,
        groupId: options.groupId ?? null,
        trigger: options.trigger,
        semanticMemoryEnabled: false,
        messagingChannelRun: false,
        emailClaimable: options.emailClaimable,
      }).map((tool) => tool.name);

    expect(names({ trigger: "user", emailClaimable: true })).toContain("claim_email_address");
    expect(names({ trigger: "user", emailClaimable: false })).not.toContain("claim_email_address");
    expect(names({ trigger: "webhook", emailClaimable: true })).not.toContain(
      "claim_email_address",
    );
    expect(names({ trigger: "user", groupId: "g", emailClaimable: true })).not.toContain(
      "claim_email_address",
    );
    // A bot that claims its address in this chat can read the sign-up mail that follows.
    expect(names({ trigger: "user", emailClaimable: true })).toContain("read_email");
    expect(names({ trigger: "webhook", emailClaimable: true })).not.toContain("read_email");
    expect(toolRequiresExplicitApproval("claim_email_address")).toBe(true);
    // Its result is the bot's own address, so a later preference change in the run still works.
    expect(toolResultTaintsRun("claim_email_address")).toBe(false);
  });
});

describe("send_email", () => {
  type Saved = Record<string, unknown> & {
    id: string;
    key: string;
    sent: boolean;
    receivedAt: Date;
  };

  function sendRun(
    options: {
      sentToday?: number;
      ownerEmail?: string;
      dailyLimit?: number;
      repliesEnabled?: boolean;
      allowedRecipients?: string[];
      verified?: boolean;
      deactivated?: boolean;
      ownerSentToday?: number;
      fail?: boolean;
      original?: Record<string, unknown>;
      secrets?: string[];
    } = {},
  ) {
    const saved: Saved[] = [];
    const send = vi.fn(async (_message: Record<string, unknown>) => {
      if (options.fail) throw new Error("domain not verified");
    });
    // Sends earlier today: this bot's, then another of its owner's bots.
    const sends = [
      ...Array.from({ length: options.sentToday ?? 0 }, () => ({
        id: "old",
        botId: "bot-1",
        recipientCount: 1,
      })),
      ...Array.from({ length: options.ownerSentToday ?? 0 }, () => ({
        id: "old",
        botId: "bot-2",
        recipientCount: 1,
      })),
    ];
    const botEmailSend = {
      deleteMany: async () => ({ count: 0 }),
      aggregate: async () => ({
        _sum: { recipientCount: sends.reduce((total, row) => total + row.recipientCount, 0) },
      }),
      create: async ({ data }: { data: { botId: string; recipientCount: number } }) => {
        const row = {
          id: `send-${sends.length + 1}`,
          botId: data.botId,
          recipientCount: data.recipientCount,
        };
        sends.push(row);
        return { id: row.id };
      },
    };
    const user = {
      findUnique: async () => ({
        email: options.ownerEmail ?? "a@shop.test",
        emailVerified: options.verified ?? true,
        deactivatedAt: options.deactivated ? new Date() : null,
        botEmailDailyLimit: options.dailyLimit ?? 10,
        botEmailRepliesEnabled: options.repliesEnabled ?? false,
        botEmailAllowedRecipients: options.allowedRecipients ?? [],
      }),
    };
    const ctx = {
      deps: {
        inboundEmailDomain: "bots.test",
        email: { send },
        prisma: {
          $transaction: async (fn: (tx: unknown) => unknown) =>
            fn({ $queryRaw: async () => [], botEmailSend, user }),
          botEmailSend,
          botEmailAddress: { findUnique: async () => ({ name: "scout" }) },
          botEmailMessage: {
            findFirst: async ({ where }: { where: { id: string } }) =>
              where.id === "in-1" && options.original
                ? {
                    fromAddress: "support@shop.test",
                    subject: "Hi",
                    messageId: "<message@example.test>",
                    references: [],
                    verified: true,
                    sent: false,
                    receivedAt: new Date(),
                    ...options.original,
                  }
                : null,
            findUnique: async ({ where }: { where: { botId_key: { key: string } } }) =>
              saved.find((row) => row.key === where.botId_key.key) ?? null,
            create: async ({ data }: { data: Record<string, unknown> }) => {
              const row = {
                ...data,
                id: `sent-${saved.length + 1}`,
                receivedAt: new Date(),
              } as Saved;
              saved.push(row);
              return { id: row.id };
            },
            delete: async ({ where }: { where: { id: string } }) => {
              saved.splice(
                saved.findIndex((row) => row.id === where.id),
                1,
              );
            },
          },
        },
      },
      bot: { id: "bot-1", userId: "owner-1", spaceId: "space-1", name: 'Scout "Bot"' },
      run: { userId: "owner-1" },
      secrets: options.secrets ?? ["hunter2-secret", "line-one\nline-two"],
    };
    const call = (args: Record<string, unknown>, effectKey = "effect-1") =>
      emailTools.send_email!(
        ctx as never,
        {
          name: "send_email",
          args,
          effectKey,
          executionId: "c",
          finish: async (r: unknown) => r,
        } as never,
      ) as Promise<Record<string, unknown>>;
    return { call, send, saved, sends };
  }

  it("sends from the bot's own address and keeps a copy in its inbox", async () => {
    const { call, send, saved } = sendRun({ ownerEmail: "Support@Shop.test" });

    const result = await call({
      to: "Support@Shop.test",
      subject: "Order 42",
      text: "My password is hunter2-secret. Where is order 42?",
    });

    expect(result).toEqual({
      sent: true,
      id: "sent-1",
      from: "scout@bots.test",
      to: ["Support@shop.test"],
    });
    expect(send).toHaveBeenCalledWith({
      from: '"Scout Bot" <scout@bots.test>',
      replyTo: "scout@bots.test",
      to: ["Support@shop.test"],
      subject: "Order 42",
      text: expect.not.stringContaining("hunter2-secret"),
    });
    expect(saved).toEqual([
      expect.objectContaining({ sent: true, fromAddress: "scout@bots.test", key: "sent:effect-1" }),
    ]);
  });

  it("keeps a reply's subject within the limit", async () => {
    const { call, send } = sendRun({
      original: { subject: "s".repeat(500), messageId: "<t@shop.test>", references: [] },
    });

    await call({ to: ["a@shop.test"], text: "Hi", inReplyTo: "in-1" });

    expect(String(send.mock.calls[0]?.[0].subject)).toHaveLength(500);
  });

  it("keeps a secret that spans lines out of the subject", async () => {
    const { call, send } = sendRun();

    await call({ to: ["a@shop.test"], subject: "Key line-one\nline-two", text: "Hi" });

    expect(send.mock.calls[0]?.[0].subject).not.toContain("line-one");
  });

  it("answers an email in its own thread", async () => {
    const { call, send } = sendRun({
      repliesEnabled: true,
      original: {
        subject: "Your ticket",
        messageId: "<t-2@shop.test>",
        references: ["<t-1@shop.test>"],
      },
    });

    await call({ to: ["support@shop.test"], text: "Thanks!", inReplyTo: "in-1" });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "Re: Your ticket",
        headers: {
          "In-Reply-To": "<t-2@shop.test>",
          References: "<t-1@shop.test> <t-2@shop.test>",
        },
      }),
    );
  });

  it("never sends an interrupted call again, and still counts one that failed", async () => {
    const retried = sendRun();
    await retried.call({ to: ["a@shop.test"], subject: "Hi", text: "Hello" });
    // Only an attempt that never finished reaches the tool again; the gate replays the rest.
    expect(
      (await retried.call({ to: ["a@shop.test"], subject: "Hi", text: "Hello" })).error,
    ).toContain("may or may not have gone out");
    expect(retried.send).toHaveBeenCalledTimes(1);

    const failing = sendRun({ fail: true });
    expect(await failing.call({ to: ["a@shop.test"], subject: "Hi", text: "Hello" })).toEqual({
      error: "Sending failed (domain not verified). It most likely did not go out.",
    });
    expect(failing.saved).toEqual([]);
    expect(failing.sends).toEqual([{ id: "send-1", botId: "bot-1", recipientCount: 1 }]);
  });

  it("cannot use a sent copy to authorize an external recipient", async () => {
    const { call, send } = sendRun({
      original: {
        subject: "Re: Your ticket",
        sent: true,
        messageId: null,
        references: ["<t-1@shop.test>", "<t-2@shop.test>"],
      },
    });

    expect(
      (await call({ to: ["support@shop.test"], text: "Any news?", inReplyTo: "in-1" })).error,
    ).toContain("isn't approved");
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses past the daily limit, too many people, or no subject", async () => {
    const { call, send } = sendRun({ sentToday: 10 });
    const many = Array.from({ length: 11 }, (_, index) => `p${index}@shop.test`);

    expect(await call({ to: ["a@shop.test"], subject: "Hi", text: "x" })).toEqual({
      error: "Your account has reached its email allowance for the last 24 hours. Try again later.",
    });
    expect(
      (
        await sendRun({ ownerSentToday: 10 }).call({
          to: ["a@shop.test"],
          subject: "Hi",
          text: "x",
        })
      ).error,
    ).toBe("Your account has reached its email allowance for the last 24 hours. Try again later.");
    expect(
      await sendRun().call({ to: ["hunter2-secret@evil.test"], subject: "Hi", text: "x" }),
    ).toEqual({ error: "A recipient's address contains a secret. Don't send it." });
    // Compared lowercased, so a change of case can't slip a secret past.
    expect(
      await sendRun({ secrets: ["Tok3nXYZ"] }).call({
        to: ["tok3nxyz@evil.test"],
        subject: "Hi",
        text: "x",
      }),
    ).toEqual({ error: "A recipient's address contains a secret. Don't send it." });
    expect(await sendRun().call({ to: many, subject: "Hi", text: "x" })).toEqual({
      error: "Send to at most 10 people at once.",
    });
    expect(await sendRun().call({ to: ["a@shop.test"], text: "x" })).toEqual({
      error: "Give the email a subject.",
    });
    expect((await sendRun().call({ to: [], subject: "Hi", text: "x" })).error).toContain(
      "Name at least one recipient.",
    );
    // Masking can lengthen the body, and the limit holds for what would go out.
    expect(
      await sendRun({ secrets: ["Q"] }).call({
        to: ["a@shop.test"],
        subject: "Hi",
        text: "Q".repeat(19_000),
      }),
    ).toEqual({ error: "The email is too long once secrets are removed. Shorten it." });
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps the part of an address before the @ as written", async () => {
    const { call, send } = sendRun({ ownerEmail: "Ada.Lovelace@Shop.TEST" });

    await call({ to: ["Ada.Lovelace@Shop.TEST"], subject: "Hi", text: "x" });

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: ["Ada.Lovelace@shop.test"] }));
  });

  it("cannot authorize new recipients, forged or stale replies, or extra copies", async () => {
    for (const original of [
      null,
      { verified: false },
      { sent: true },
      { receivedAt: new Date(Date.now() - 31 * 86_400_000) },
      { fromAddress: "another@bots.test" },
    ]) {
      const { call, send, sends } = sendRun({
        repliesEnabled: true,
        original: original ?? undefined,
      });
      const result = await call({
        to: "support@shop.test",
        subject: "Hi",
        text: "Hello",
        ...(original ? { inReplyTo: "in-1" } : {}),
      });
      expect(result.error).toContain("isn't approved");
      expect(send).not.toHaveBeenCalled();
      expect(sends).toHaveLength(0);
    }
    const { call, send } = sendRun({
      repliesEnabled: true,
      original: { subject: "Hi", messageId: "<message@example.test>", references: [] },
    });
    expect(
      (
        await call({
          to: "support@shop.test",
          cc: "victim@example.test",
          text: "Hello",
          inReplyTo: "in-1",
        })
      ).error,
    ).toContain("isn't approved");
    expect(send).not.toHaveBeenCalled();
  });

  it("does not authorize a differently cased mailbox local part", async () => {
    const { call, send } = sendRun({ ownerEmail: "Owner@shop.test" });
    expect((await call({ to: "owner@shop.test", subject: "Hi", text: "Hello" })).error).toContain(
      "isn't approved",
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("allows an operator-approved recipient for a scheduled report without granting arbitrary sending", async () => {
    const { call, send } = sendRun({ allowedRecipients: ["reports@example.test"] });
    expect(
      await call({ to: "reports@example.test", subject: "Weekly report", text: "Activity report" }),
    ).toMatchObject({ sent: true });
    expect(send).toHaveBeenCalledOnce();
    expect(
      (await call({ to: "other@example.test", subject: "Hi", text: "Hello" }, "other-effect"))
        .error,
    ).toContain("isn't approved");
    expect(send).toHaveBeenCalledOnce();
  });

  it("counts CC recipients and lets the operator raise, lower, or pause the account allowance", async () => {
    const original = { subject: "Hi", messageId: "<message@example.test>", references: [] };
    const lowered = sendRun({ repliesEnabled: true, original, dailyLimit: 1 });
    expect(
      await lowered.call({
        to: "support@shop.test",
        cc: "a@shop.test",
        text: "Hello",
        inReplyTo: "in-1",
      }),
    ).toEqual({
      error:
        "This email has more recipients than your account's allowance. Send to fewer recipients.",
    });
    expect(lowered.send).not.toHaveBeenCalled();
    expect(lowered.sends).toHaveLength(0);
    expect(lowered.saved).toHaveLength(0);
    expect(await lowered.call({ to: "a@shop.test", subject: "Hi", text: "Hello" })).toMatchObject({
      sent: true,
    });
    const limited = sendRun({ repliesEnabled: true, original, sentToday: 9 });
    expect(
      (
        await limited.call({
          to: "support@shop.test",
          cc: "a@shop.test",
          text: "Hello",
          inReplyTo: "in-1",
        })
      ).error,
    ).toContain("allowance");
    expect(limited.send).not.toHaveBeenCalled();
    const raised = sendRun({ repliesEnabled: true, original, sentToday: 9, dailyLimit: 12 });
    expect(
      await raised.call({
        to: "support@shop.test",
        cc: "a@shop.test",
        text: "Hello",
        inReplyTo: "in-1",
      }),
    ).toMatchObject({ sent: true });
    expect(raised.sends.at(-1)?.recipientCount).toBe(2);
    for (const options of [{ dailyLimit: 0 }, { verified: false }, { deactivated: true }]) {
      const run = sendRun(options);
      expect(
        (await run.call({ to: "a@shop.test", subject: "Hi", text: "Hello" })).error,
      ).toBeTruthy();
      expect(run.send).not.toHaveBeenCalled();
      expect(run.sends).toHaveLength(0);
    }
  });

  it("is offered only where the inbox is read and email can go out, under the usual approvals", () => {
    const names = (emailSend: boolean) =>
      selectBuiltinToolsForRun({
        graphicalToolsAllowed: false,
        groupId: null,
        trigger: "user",
        semanticMemoryEnabled: false,
        messagingChannelRun: false,
        emailInbox: true,
        emailSend,
      }).map((tool) => tool.name);

    expect(names(true)).toContain("send_email");
    expect(names(false)).not.toContain("send_email");
    expect(toolRequiresApproval("send_email", false)).toBe(true);
    expect(toolRequiresExplicitApproval("send_email")).toBe(false);
    expect(toolResultTaintsRun("send_email")).toBe(false);
  });
});
