import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { WorkActivityPushProvider } from "./work-activity.js";
import { WORK_ACTIVITY_ROWS, WorkActivities } from "./work-activity.js";

type Run = {
  id: string;
  threadId: string;
  userId: string;
  botId: string;
  status: string;
  trigger: string;
  groupId?: string;
  createdAt: Date;
};
type Card = {
  tokenDigest: string;
  userId: string;
  sessionId: string;
  ciphertext: string;
  lastState: string | null;
  lastWaiting: number;
};

type Phone = {
  tokenDigest: string;
  userId: string;
  sessionId: string;
  ciphertext: string;
  startedAt: Date | null;
};

const TOKEN = "ab".repeat(32);
const START_TOKEN = "cd".repeat(32);

/** Just the reads and writes WorkActivities makes, kept in memory. Newer runs come later. */
function fakeDatabase() {
  const runs: Run[] = [];
  const events: Array<{ runId: string; type: string; seq: number; payload: unknown }> = [];
  const cards = new Map<string, Card>();
  const phones = new Map<string, Phone>();
  /** Sessions still signed in. */
  const sessions = new Set(["session-1", "session-2"]);
  const newestFirst = (list: Run[]) => [...list].reverse();
  const prisma = {
    run: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        runs.find((run) => run.id === where.id) ?? null,
      findMany: async ({
        where,
        take,
      }: {
        where: { threadId?: string; userId?: string; status?: { in: string[] } };
        take?: number;
      }) =>
        newestFirst(runs)
          .filter(
            (run) =>
              (!where.threadId || run.threadId === where.threadId) &&
              (!where.userId || run.userId === where.userId) &&
              (!where.status || where.status.in.includes(run.status)),
          )
          .filter((run, index, list) =>
            where.threadId
              ? list.findIndex((other) => other.userId === run.userId) === index
              : true,
          )
          .slice(0, take)
          .map((run) => ({
            ...run,
            spaceId: "space-1",
            bot: { name: run.botId === "bot-1" ? "Planner" : `Bot ${run.botId}` },
            thread: { groupId: run.groupId ?? null },
          })),
    },
    event: {
      findMany: async ({
        where,
        take,
      }: {
        where: { runId: string; type: string; seq?: { lt?: number; gt?: number } };
        take: number;
      }) =>
        events
          .filter(
            (event) =>
              event.runId === where.runId &&
              event.type === where.type &&
              (where.seq?.lt === undefined || event.seq < where.seq.lt) &&
              (where.seq?.gt === undefined || event.seq > where.seq.gt),
          )
          .sort((a, b) => b.seq - a.seq)
          .slice(0, take),
    },
    session: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.filter((id) => sessions.has(id)).map((id) => ({ id })),
    },
    workActivityToken: {
      upsert: async (input: {
        where: { tokenDigest: string };
        create: Omit<Card, "lastState" | "lastWaiting">;
      }) => {
        const current = cards.get(input.where.tokenDigest);
        cards.set(
          input.where.tokenDigest,
          current ?? { lastState: null, lastWaiting: 0, ...input.create },
        );
      },
      // Cards are kept in registration order, so newest first is reverse order.
      findMany: async ({ where, skip = 0 }: { where: { userId: string }; skip?: number }) =>
        [...cards.values()]
          .filter((card) => card.userId === where.userId)
          .reverse()
          .slice(skip),
      deleteMany: async ({
        where,
      }: {
        where: { tokenDigest: string; userId?: string | { not: string } };
      }) => {
        const card = cards.get(where.tokenDigest);
        const owner = where.userId;
        const matches =
          owner === undefined ||
          (typeof owner === "string" ? card?.userId === owner : card?.userId !== owner.not);
        if (card && matches) cards.delete(where.tokenDigest);
      },
      updateMany: async (input: { where: Partial<Card>; data: Partial<Card> }) => {
        let count = 0;
        for (const card of cards.values()) {
          const matches = Object.entries(input.where).every(
            ([key, value]) => card[key as keyof Card] === value,
          );
          if (matches) {
            Object.assign(card, input.data);
            count += 1;
          }
        }
        return { count };
      },
    },
    workActivityStartToken: {
      upsert: async (input: {
        where: { tokenDigest: string };
        create: Omit<Phone, "startedAt"> & { startedAt?: Date | null };
      }) => {
        if (!phones.has(input.where.tokenDigest))
          phones.set(input.where.tokenDigest, { startedAt: null, ...input.create });
      },
      findMany: async ({
        where,
        skip = 0,
      }: {
        where: { userId: string; sessionId?: string };
        skip?: number;
      }) =>
        [...phones.values()]
          .filter(
            (phone) =>
              phone.userId === where.userId &&
              (!where.sessionId || phone.sessionId === where.sessionId),
          )
          .reverse()
          .slice(skip),
      deleteMany: async ({
        where,
      }: {
        where: {
          tokenDigest?: string | { in: string[] };
          userId: string | { not: string };
          sessionId?: string;
        };
      }) => {
        for (const [digest, phone] of phones) {
          const digestMatches =
            where.tokenDigest === undefined ||
            (typeof where.tokenDigest === "string"
              ? digest === where.tokenDigest
              : where.tokenDigest.in.includes(digest));
          const ownerMatches =
            typeof where.userId === "string"
              ? phone.userId === where.userId
              : phone.userId !== where.userId.not;
          const sessionMatches = !where.sessionId || phone.sessionId === where.sessionId;
          if (digestMatches && ownerMatches && sessionMatches) phones.delete(digest);
        }
      },
      updateMany: async (input: { where: Partial<Phone>; data: Partial<Phone> }) => {
        let count = 0;
        for (const phone of phones.values()) {
          const matches = Object.entries(input.where).every(
            ([key, value]) => phone[key as keyof Phone] === value,
          );
          if (matches) {
            Object.assign(phone, input.data);
            count += 1;
          }
        }
        return { count };
      },
    },
  } as unknown as PrismaClient;
  return { prisma, runs, events, cards, phones, sessions };
}

function setup(reply: "sent" | "invalid" | "unavailable" = "sent", windowMs = 20) {
  const db = fakeDatabase();
  const send = vi.fn<WorkActivityPushProvider["send"]>().mockResolvedValue(reply);
  const start = vi.fn<WorkActivityPushProvider["start"]>().mockResolvedValue("sent");
  const activities = new WorkActivities(
    db.prisma,
    "offline-activity-key",
    { send, start },
    windowMs,
  );
  const run = (id: string, more: Partial<Run> = {}) =>
    db.runs.push({
      id,
      threadId: `thread-${id}`,
      userId: "user-1",
      botId: `bot-${id}`,
      status: "running",
      trigger: "message",
      // Old enough that no phone is still about to register its own card for it.
      createdAt: new Date(Date.now() - 60_000),
      ...more,
    });
  run("1", { threadId: "thread-1", botId: "bot-1" });
  return { ...db, send, start, activities, run };
}

async function registered(reply?: "sent" | "invalid" | "unavailable", windowMs?: number) {
  const context = setup(reply, windowMs);
  expect(await context.activities.register("user-1", "session-1", TOKEN)).toBe(true);
  await vi.waitFor(() => expect(context.send).toHaveBeenCalledTimes(1));
  return context;
}

describe("live status card of the user's bots at work", () => {
  it("follows only while one of the user's bots is at work", async () => {
    const { activities, cards, runs } = setup();
    expect(await activities.register("user-2", "session-2", TOKEN)).toBe(false);
    runs[0]!.status = "completed";
    expect(await activities.register("user-1", "session-1", TOKEN)).toBe(false);
    expect(cards.size).toBe(0);
  });

  it("shows the bot's latest step and sends nothing while it is unchanged", async () => {
    const { activities, cards, events, send } = setup();
    events.push(
      {
        runId: "1",
        type: "thread.progress",
        seq: 1,
        payload: { text: "Reading  the\nbrief", activity: true },
      },
      { runId: "1", type: "thread.progress", seq: 2, payload: { delta: "Here", streaming: true } },
    );
    await activities.register("user-1", "session-1", TOKEN);
    // The token is stored encrypted.
    expect([...cards.values()][0]!.ciphertext).not.toContain(TOKEN);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    // So is the state, which holds chat content.
    await vi.waitFor(() => expect([...cards.values()][0]!.lastState).toBeTruthy());
    expect([...cards.values()][0]!.lastState).not.toContain("Reading");
    expect(send).toHaveBeenCalledWith(TOKEN, {
      state: {
        count: 1,
        waiting: 0,
        rows: [
          {
            status: "working",
            title: "Planner",
            line: "Reading the brief",
            spaceId: "space-1",
            botId: "bot-1",
          },
        ],
      },
      ended: false,
      urgent: false,
      at: expect.any(Number),
    });
    await activities.sync("user-1");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("finds the latest step behind a long stream of text", async () => {
    const { activities, events, send } = await registered();
    events.push({
      runId: "1",
      type: "thread.progress",
      seq: 1,
      payload: { text: "Drafting", activity: true },
    });
    for (let seq = 2; seq < 120; seq += 1)
      events.push({
        runId: "1",
        type: "thread.progress",
        seq,
        payload: { delta: "x", streaming: true },
      });
    await activities.sync("user-1");
    expect(send.mock.lastCall![1].state.rows[0]!.line).toBe("Drafting");
  });

  it("counts a bot's background helpers as that bot", async () => {
    const { activities, run, send } = await registered();
    run("h1", { botId: "bot-1", trigger: "helper" });
    run("h2", { botId: "bot-1", trigger: "helper" });
    await activities.sync("user-1");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.lastCall![1].state.count).toBe(1);
  });

  it("sums up every bot at work on one card, questions first", async () => {
    const { activities, run, send } = await registered();
    for (const id of ["2", "3", "4", "5"]) run(id);
    run("6", { status: "waiting_input", groupId: "group-6" });
    // A continuation of a chat's work and background work add no rows.
    run("7", { threadId: "thread-1", botId: "bot-1" });
    run("8", { trigger: "tickets" });
    await activities.sync("user-1");
    const push = send.mock.lastCall![1];
    expect(push).toMatchObject({ ended: false, urgent: true, state: { count: 6, waiting: 1 } });
    expect(push.state.rows).toHaveLength(WORK_ACTIVITY_ROWS);
    expect(push.state.rows[0]).toEqual({
      status: "waiting",
      title: "Bot bot-6",
      line: "",
      spaceId: "space-1",
      groupId: "group-6",
    });
    expect(push.state.rows.slice(1).map((row) => row.title)).toEqual([
      "Planner",
      "Bot bot-5",
      "Bot bot-4",
    ]);
  });

  it("keeps a question open in a chat ahead of newer work in it", async () => {
    const { activities, run, runs, send } = await registered();
    runs[0]!.status = "waiting_input";
    run("9", { threadId: "thread-1", botId: "bot-1", status: "queued" });
    await activities.sync("user-1");
    expect(send.mock.lastCall![1]).toMatchObject({
      urgent: true,
      state: { count: 1, waiting: 1, rows: [{ status: "waiting", title: "Planner" }] },
    });
  });

  it("ends the card once no bot is at work", async () => {
    const { activities, cards, runs, send } = await registered();
    runs[0]!.status = "completed";
    await activities.sync("user-1");
    expect(send.mock.lastCall![1]).toMatchObject({
      ended: true,
      urgent: true,
      state: { count: 0, waiting: 0, rows: [] },
    });
    expect(cards.size).toBe(0);
  });

  it("tries again a push that did not go through, ending the card only once it does", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { activities, cards, runs, send } = await registered("unavailable");
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
      runs[0]!.status = "completed";
      send.mockResolvedValue("unavailable");
      await activities.sync("user-1");
      expect(send.mock.lastCall![1].ended).toBe(true);
      expect(cards.size).toBe(1);
      send.mockResolvedValue("sent");
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await vi.waitFor(() => expect(cards.size).toBe(0));
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends a card once the session that registered it ends, and follows a replacement", async () => {
    const { activities, cards, send, sessions } = await registered();
    await activities.endSession("user-1", "session-1", "session-2");
    expect([...cards.values()][0]!.sessionId).toBe("session-2");
    sessions.delete("session-2");
    await activities.endSession("user-1", "session-2");
    await vi.waitFor(() => expect(cards.size).toBe(0));
    // It leaves at once; nothing about the work reaches the signed-out phone.
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.lastCall![1]).toMatchObject({
      ended: true,
      state: { count: 0, waiting: 0, rows: [] },
    });
  });

  it("keeps a few cards per user, ending the oldest", async () => {
    const { activities, cards, send } = setup();
    for (let phone = 0; phone < 7; phone += 1)
      await activities.register("user-1", "session-1", String(phone).repeat(64));
    expect(cards.size).toBe(5);
    // The cards dropped are ended, not left on their phones without updates.
    for (const phone of ["0", "1"])
      expect(send).toHaveBeenCalledWith(phone.repeat(64), expect.objectContaining({ ended: true }));
  });

  it("re-registers a card without sealing its token again", async () => {
    const { activities, cards } = await registered();
    const sealed = [...cards.values()][0]!.ciphertext;
    await activities.register("user-1", "session-2", TOKEN);
    expect([...cards.values()][0]).toMatchObject({ ciphertext: sealed, sessionId: "session-2" });
  });

  it("keeps a found step through later streamed text without reading it again", async () => {
    const { activities, events, send, prisma } = await registered();
    events.push({
      runId: "1",
      type: "thread.progress",
      seq: 1,
      payload: { text: "Drafting", activity: true },
    });
    await activities.sync("user-1");
    for (let seq = 2; seq < 300; seq += 1)
      events.push({
        runId: "1",
        type: "thread.progress",
        seq,
        payload: { delta: "x", streaming: true },
      });
    const read = vi.spyOn(prisma.event, "findMany");
    await activities.sync("user-1");
    expect(send.mock.lastCall![1].state.rows[0]!.line).toBe("Drafting");
    // Only progress newer than the step already found.
    expect(
      read.mock.calls.every(
        ([args]) => (args as { where: { seq: { gt?: number } } }).where.seq.gt !== undefined,
      ),
    ).toBe(true);
  });

  it("ends a deleted account's cards on their phones", async () => {
    const { activities, cards, send } = await registered();
    await activities.endUser("user-1");
    expect(cards.size).toBe(0);
    expect(send.mock.lastCall![1]).toMatchObject({ ended: true, state: { rows: [] } });
  });

  it("starts a card over when another account registers it", async () => {
    const { activities, cards, run } = await registered();
    run("2", { userId: "user-2" });
    await vi.waitFor(() => expect([...cards.values()][0]!.lastState).toBeTruthy());
    await activities.register("user-2", "session-2", TOKEN);
    expect([...cards.values()][0]).toMatchObject({ userId: "user-2", lastState: null });
  });

  it("clears the step when the bot clears it", async () => {
    const { activities, events, send } = await registered();
    events.push({
      runId: "1",
      type: "thread.progress",
      seq: 1,
      payload: { text: "Searching", activity: true },
    });
    await activities.sync("user-1");
    expect(send.mock.lastCall![1].state.rows[0]!.line).toBe("Searching");
    events.push({
      runId: "1",
      type: "thread.progress",
      seq: 2,
      payload: { text: "", activity: true },
    });
    await activities.sync("user-1");
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.lastCall![1].state.rows[0]!.line).toBe("");
  });

  it("forgets a card Apple no longer knows", async () => {
    const { cards } = await registered("invalid");
    expect(cards.size).toBe(0);
  });

  it("updates the owners of a changed thread's work, at most once per window", async () => {
    // Only the clock is fake: the window passes when the test says so, never under load.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const window = 10_000;
      const { activities, events, send } = await registered("sent", window);
      await vi.advanceTimersByTimeAsync(window);
      const step = (seq: number) => {
        events.push({
          runId: "1",
          type: "thread.progress",
          seq,
          payload: { text: `Step ${seq}`, activity: true },
        });
        activities.threadChanged("thread-1");
      };
      step(1);
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
      step(2);
      step(3);
      await vi.advanceTimersByTimeAsync(window / 2);
      expect(send).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(window);
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
      expect(send.mock.calls.map(([, push]) => push.state.rows[0]!.line)).toEqual([
        "",
        "Step 1",
        "Step 3",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("started by push on a phone without one", () => {
    it("starts one card per stretch of work on each signed-in phone that has none", async () => {
      const { activities, phones, runs, run, start, send } = setup();
      await activities.registerStarts("user-1", "session-1", START_TOKEN);
      await activities.registerStarts("user-1", "session-2", "ef".repeat(32));
      // The token is stored encrypted.
      expect([...phones.values()][0]!.ciphertext).not.toContain(START_TOKEN);
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
      expect(start).toHaveBeenCalledWith(START_TOKEN, {
        state: expect.objectContaining({ count: 1 }),
        ended: false,
        urgent: true,
        at: expect.any(Number),
      });
      expect(send).not.toHaveBeenCalled();
      // Until its card registers, or after the user dismissed it, the same work starts no other.
      await activities.sync("user-1");
      expect(start).toHaveBeenCalledTimes(2);
      // New work after a pause starts one again.
      runs[0]!.status = "completed";
      run("2", { createdAt: new Date(Date.now() - 20_000) });
      for (const phone of phones.values()) phone.startedAt = new Date(Date.now() - 30_000);
      await activities.sync("user-1");
      expect(start).toHaveBeenCalledTimes(4);
    });

    it("leaves a phone that shows its own card, and waits for the one that just sent", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        const { activities, cards, run, runs, start } = setup();
        runs.length = 0;
        run("1", { createdAt: new Date() });
        await activities.registerStarts("user-1", "session-1", START_TOKEN);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(start).not.toHaveBeenCalled();
        // The phone that sent registers its own card in the meantime.
        expect(await activities.register("user-1", "session-1", TOKEN)).toBe(true);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(start).not.toHaveBeenCalled();
        // Its card going, such as when the user dismisses it, starts no other for the same work.
        cards.clear();
        await activities.sync("user-1");
        expect(start).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("starts the card once the grace for a just-sent message passes", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        const { activities, run, runs, start } = setup();
        runs.length = 0;
        run("1", { createdAt: new Date() });
        await activities.registerStarts("user-1", "session-1", START_TOKEN);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(start).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(10_000);
        await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
      } finally {
        vi.useRealTimers();
      }
    });

    it("starts nothing on a signed-out phone, and forgets one Apple no longer knows", async () => {
      const { activities, phones, sessions, start } = setup();
      await activities.registerStarts("user-1", "session-1", START_TOKEN);
      await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
      phones.get([...phones.keys()][0]!)!.startedAt = null;
      sessions.delete("session-1");
      await activities.sync("user-1");
      expect(start).toHaveBeenCalledOnce();
      await activities.endSession("user-1", "session-1");
      expect(phones.size).toBe(0);

      start.mockResolvedValue("invalid");
      await activities.registerStarts("user-1", "session-2", START_TOKEN);
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(phones.size).toBe(0));
    });

    it("counts a chat's continuation as the same stretch of work", async () => {
      const { activities, phones, run, runs, start } = setup();
      runs[0]!.createdAt = new Date(Date.now() - 180_000);
      await activities.registerStarts("user-1", "session-1", START_TOKEN);
      await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
      for (const phone of phones.values()) phone.startedAt = new Date(Date.now() - 120_000);
      run("7", { threadId: "thread-1", botId: "bot-1", createdAt: new Date(Date.now() - 20_000) });
      await activities.sync("user-1");
      expect(start).toHaveBeenCalledOnce();
    });

    it("starts a card once when two processes follow the same work", async () => {
      const { prisma, start } = setup();
      const other = new WorkActivities(prisma, "offline-activity-key", {
        send: vi.fn().mockResolvedValue("sent"),
        start,
      });
      const first = new WorkActivities(prisma, "offline-activity-key", {
        send: vi.fn().mockResolvedValue("sent"),
        start,
      });
      await first.registerStarts("user-1", "session-1", START_TOKEN);
      await Promise.all([first.sync("user-1"), other.sync("user-1")]);
      await vi.waitFor(() => expect(start).toHaveBeenCalled());
      expect(start).toHaveBeenCalledOnce();
    });

    it("keeps a phone's last start when iOS gives it a new token", async () => {
      const { activities, phones, start } = setup();
      await activities.registerStarts("user-1", "session-1", START_TOKEN);
      await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
      await activities.registerStarts("user-1", "session-1", "ef".repeat(32));
      await activities.sync("user-1");
      expect(phones.size).toBe(1);
      expect([...phones.values()][0]!.startedAt).not.toBeNull();
      expect(start).toHaveBeenCalledOnce();
    });

    it("tries again a start that did not go through, without holding back the cards", async () => {
      const { activities, cards, phones, send, start } = await registered();
      start.mockRejectedValueOnce(new Error("broken"));
      await activities.registerStarts("user-1", "session-2", START_TOKEN);
      await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect([...phones.values()][0]!.startedAt).toBeNull());
      // The card on the other phone still follows the work.
      expect(cards.size).toBe(1);
      expect(send).toHaveBeenCalled();
      await activities.sync("user-1");
      expect(start).toHaveBeenCalledTimes(2);
    });

    it("moves to a replacement session and to the account signed in last", async () => {
      const { activities, phones } = setup();
      await activities.registerStarts("user-1", "session-1", START_TOKEN);
      await activities.endSession("user-1", "session-1", "session-2");
      expect([...phones.values()][0]).toMatchObject({ sessionId: "session-2" });
      await activities.registerStarts("user-2", "session-2", START_TOKEN);
      expect([...phones.values()]).toEqual([expect.objectContaining({ userId: "user-2" })]);
    });
  });
});
