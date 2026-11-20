import { describe, it, expect } from "vitest";
import {
  createSessionSteward,
  decodeStewardCatalog,
  type StewardDependencies,
} from "./sessionSteward.web";
function fixture() {
  let current = true;
  let sent = 0;
  let resumed = 0;
  const session = {
    id: "s",
    seq: 9,
    active: true,
    metadata: {
      summary: { text: "Fix menu" },
      machineId: "m",
      codexThreadId: "thread",
      flavor: "codex",
    },
    agentState: { turnStatus: { status: "completed", turnId: "old" } },
  };
  let messages: any[] = [];
  const deps: StewardDependencies = {
    current: () => current,
    list: async () => ({
      sessions: [session],
      nextCursor: "older",
      hasNext: true,
    }),
    get: async () => session,
    history: async () => ({ messages, hasMore: false }),
    send: async () => {
      sent++;
      return { localIds: ["input"] };
    },
    resume: async () => {
      resumed++;
      return { type: "success", sessionId: "s" };
    },
    waitForChange: async () => false,
  };
  return {
    host: createSessionSteward(deps),
    session,
    deps,
    setMessages: (rows: any[]) => {
      messages = rows;
    },
    switchAccount: () => {
      current = false;
    },
    sent: () => sent,
    resumed: () => resumed,
  };
}
const row = (seq: number, ev: any, turn = "t") => ({
  id: String(seq),
  seq,
  content: {
    role: "session",
    content: { id: String(seq), time: seq, role: "agent", turn, ev },
  },
  localId: null,
  createdAt: seq,
});
describe("Web session steward", () => {
  it("preserves catalog pagination without claiming complete coverage", async () => {
    const f = fixture();
    expect(
      await f.host.execute({ id: "q", tool: "paws_sessions_list", args: {} }),
    ).toMatchObject({ nextCursor: "older", hasNext: true });
  });
  it("tracks exact accepted local id and never substitutes another completed turn", async () => {
    const f = fixture();
    const receipt: any = await f.host.execute({
      id: "send",
      tool: "paws_session_send",
      args: { sessionId: "s", text: "fix" },
    });
    expect(receipt).toMatchObject({ status: "queued", commandId: "send" });
    f.setMessages([
      row(10, { t: "turn-start", localIds: ["someone-else"] }, "other"),
      row(11, { t: "turn-end", status: "completed" }, "other"),
    ]);
    expect(
      await f.host.execute({
        id: "r1",
        tool: "paws_session_result",
        args: { sessionId: "s", commandId: "send" },
      }),
    ).toMatchObject({ status: "queued" });
    f.setMessages([
      row(12, { t: "turn-start", localIds: ["input"] }),
      row(13, { t: "text", text: "done" }),
      row(14, { t: "turn-end", status: "failed" }),
    ]);
    expect(
      await f.host.execute({
        id: "r2",
        tool: "paws_session_result",
        args: { sessionId: "s", commandId: "send" },
      }),
    ).toMatchObject({ status: "failed", turnId: "t" });
  });
  it("deduplicates writes and refuses mutations after account switch", async () => {
    const f = fixture();
    const request = {
      id: "send",
      tool: "paws_session_send",
      args: { sessionId: "s", text: "x" },
    };
    await Promise.all([f.host.execute(request), f.host.execute(request)]);
    expect(f.sent()).toBe(1);
    f.switchAccount();
    await expect(f.host.execute({ ...request, id: "next" })).rejects.toThrow(
      "account-changed",
    );
    expect(f.sent()).toBe(1);
  });
  it("resume never sends an old instruction or claims task completion", async () => {
    const f = fixture();
    f.session.active = false;
    expect(
      await f.host.execute({
        id: "resume",
        tool: "paws_session_resume",
        args: { sessionId: "s" },
      }),
    ).toMatchObject({ status: "launch-acknowledged" });
    expect(f.sent()).toBe(0);
    expect(f.resumed()).toBe(1);
  });
  it("fails closed on unsupported tool, unknown receipt, wrong session and malformed args", async () => {
    const f = fixture();
    await expect(
      f.host.execute({ id: "x", tool: "shell", args: {} }),
    ).rejects.toThrow("unsupported-tool");
    await expect(
      f.host.execute({
        id: "x",
        tool: "paws_session_send",
        args: { sessionId: "s", text: "" },
      }),
    ).rejects.toThrow();
    expect(
      await f.host.execute({
        id: "r",
        tool: "paws_session_result",
        args: { sessionId: "s", commandId: "missing" },
      }),
    ).toMatchObject({ status: "unknown" });
  });
});

it("preserves pagination when a catalog page includes an unreadable or concurrently deleted session", async () => {
  const page = await decodeStewardCatalog(
    {
      sessions: [{ id: "healthy" }, { id: "bad" }],
      nextCursor: "older",
      hasNext: true,
    },
    async (row) => {
      if (row.id === "bad") throw new Error("unreadable");
      return row;
    },
  );
  expect(page).toEqual({
    sessions: [{ id: "healthy" }],
    unavailableSessionIds: ["bad"],
    nextCursor: "older",
    hasNext: true,
  });
});

it("refuses to send if account ownership changes while the target is being loaded", async () => {
  const f = fixture();
  const get = f.deps.get;
  f.deps.get = async (id) => {
    const value = await get(id);
    f.switchAccount();
    return value;
  };
  await expect(
    f.host.execute({
      id: "switch",
      tool: "paws_session_send",
      args: { sessionId: "s", text: "x" },
    }),
  ).rejects.toThrow("account-changed");
  expect(f.sent()).toBe(0);
});
