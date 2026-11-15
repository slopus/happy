import { describe, expect, it, vi } from "vitest";
import type { EvalActor, EvalApp } from "./runner.js";
import { cleanupActors } from "./runner.js";

const actors: EvalActor[] = [
  {
    botId: "root-bot",
    cookie: "root-session",
    userId: "eval-user",
    spaceId: "eval-space",
  },
];

function fixture(options: { failDisable?: boolean; failStop?: boolean } = {}) {
  const bots = [
    { id: "root-bot", userId: "eval-user", spaceId: "eval-space" },
    { id: "child-bot", userId: "eval-user", spaceId: "eval-space" },
  ];
  const runs = [
    { id: "root-run", botId: "root-bot", status: "running" },
    { id: "child-run", botId: "child-bot", status: "running" },
  ];
  const order: string[] = [];
  let lateChildCreated = false;
  let releaseQuietAbort!: () => void;
  const quietAbort = new Promise<void>((resolve) => {
    releaseQuietAbort = resolve;
  });
  const updateMany = vi.fn(async () => {
    order.push("disable");
    if (options.failDisable) throw new Error("database unavailable");
    return { count: 1 };
  });
  const request = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { json: { botId: string } };
    order.push(`stop:${body.json.botId}`);
    for (const run of runs) if (run.botId === body.json.botId) run.status = "cancelled";
    return Response.json({ json: { ok: true } }, { status: options.failStop ? 500 : 200 });
  });
  const cancel = vi.fn(async (key: string) => {
    order.push(`cancel:${key}`);
  });
  const abort = vi.fn(async (runId: string) => {
    order.push(`abort:${runId}`);
    if (runId === "root-run" && !lateChildCreated) {
      lateChildCreated = true;
      bots.push({ id: "late-child-bot", userId: "eval-user", spaceId: "eval-space" });
      runs.push({ id: "late-child-run", botId: "late-child-bot", status: "running" });
    }
    if (runId === "child-run") await quietAbort;
  });
  const findRuns = vi.fn(async (args: { select: { status?: boolean } }) =>
    runs.map((run) => (args.select.status ? { id: run.id, status: run.status } : { id: run.id })),
  );
  const handles = {
    app: { request },
    jobs: { cancel },
    runtime: { abort },
    prisma: {
      bot: { findMany: vi.fn(async () => bots.map((bot) => ({ ...bot }))) },
      run: { findMany: findRuns },
      routine: { updateMany, count: vi.fn(async () => 0) },
    },
  } as unknown as EvalApp;
  return {
    handles,
    order,
    updateMany,
    request,
    cancel,
    abort,
    releaseQuietAbort,
  };
}

describe("eval trial isolation", () => {
  it("awaits quiet runtime aborts and catches descendants created during root abort", async () => {
    const f = fixture();
    let settled = false;
    const cleanup = cleanupActors(f.handles, actors).then(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(f.abort).toHaveBeenCalledWith("child-run"));
    expect(settled).toBe(false);
    f.releaseQuietAbort();
    await cleanup;

    expect(f.request).toHaveBeenCalledWith(
      "/rpc/threads/stop",
      expect.objectContaining({ headers: expect.objectContaining({ cookie: "root-session" }) }),
    );
    expect(f.order.indexOf("disable")).toBeLessThan(f.order.indexOf("stop:root-bot"));
    expect(f.order).toContain("stop:child-bot");
    expect(f.order).toContain("stop:late-child-bot");
    expect(f.cancel).toHaveBeenCalledWith("run:late-child-run");
    expect(f.abort).toHaveBeenCalledWith("late-child-run");
    expect(f.updateMany).toHaveBeenCalledWith({
      where: { OR: [{ userId: "eval-user", spaceId: "eval-space" }] },
      data: { active: false, nextRunAt: null },
    });
  });

  it.each([[{ failDisable: true }], [{ failStop: true }]])(
    "attempts cancellation and fails cleanup after a cleanup operation fails",
    async (options) => {
      const f = fixture(options);
      f.releaseQuietAbort();
      await expect(cleanupActors(f.handles, actors)).rejects.toThrow("could not be stopped");
      expect(f.cancel).toHaveBeenCalledWith("run:root-run");
      expect(f.abort).toHaveBeenCalledWith("root-run");
    },
  );
});
