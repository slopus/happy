import { describe, expect, it, vi } from "vitest";
import type { BotIntroHarness } from "./discard-bot-intro.js";
import { discardBotIntroRun } from "./discard-bot-intro.js";

describe("discardBotIntroRun", () => {
  it("stops the creation intro before a scripted model step is consumed", async () => {
    const steps: string[] = [];
    let status = "queued";
    let aborted = false;
    const consumeIntro = () => {
      if (aborted || status === "cancelled") return;
      steps.push("intro");
    };
    setTimeout(() => {
      void (async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        consumeIntro();
      })();
    }, 0);
    const request = vi.fn(async (url: string) => {
      if (url.endsWith("/rpc/threads/stop")) status = "cancelled";
      return Response.json({ json: { ok: true } });
    });
    const findMany = vi.fn(async () => [{ id: "intro-run", status }]);
    const count = vi.fn(async () => 0);
    const cancel = vi.fn(async () => undefined);
    const abort = vi.fn(async () => {
      aborted = true;
      status = "cancelled";
    });
    const harness = {
      app: { request },
      prisma: {
        bot: { findUnique: vi.fn(async () => ({ spaceId: "space-support" })) },
        run: { findMany },
        attempt: { count },
      },
      jobs: { cancel },
      runtime: { abort },
    } as unknown as BotIntroHarness;

    await discardBotIntroRun(harness, "session", "bot-1");
    steps.push("scenario");

    expect(steps).toEqual(["scenario"]);
    expect(request).toHaveBeenCalledWith(
      "/rpc/threads/stop",
      expect.objectContaining({
        headers: expect.objectContaining({
          cookie: "session",
          "x-rakazo-space-id": "space-support",
        }),
        body: JSON.stringify({ json: { botId: "bot-1" } }),
      }),
    );
    expect(cancel).toHaveBeenCalledWith("run:intro-run");
    expect(abort).toHaveBeenCalledWith("intro-run");
    expect(status).toBe("cancelled");
  });

  it("waits until a still-active intro run is gone", async () => {
    let reads = 0;
    const request = vi.fn(async () => Response.json({ json: { ok: true } }));
    const findMany = vi.fn(async () => {
      reads += 1;
      return [{ id: "intro-run", status: reads < 3 ? "running" : "cancelled" }];
    });
    const count = vi.fn(async () => (reads < 3 ? 1 : 0));
    const harness = {
      app: { request },
      prisma: {
        bot: { findUnique: vi.fn(async () => ({ spaceId: "space-1" })) },
        run: { findMany },
        attempt: { count },
      },
      jobs: { cancel: vi.fn(async () => undefined) },
      runtime: { abort: vi.fn(async () => undefined) },
    } as unknown as BotIntroHarness;

    await discardBotIntroRun(harness, "session", "bot-1");

    expect(reads).toBeGreaterThanOrEqual(3);
    expect(findMany).toHaveBeenLastCalledWith({
      where: { botId: "bot-1" },
      select: { id: true, status: true },
    });
  });

  it("fails when the intro run stays active", async () => {
    const harness = {
      app: { request: vi.fn(async () => Response.json({ json: { ok: true } })) },
      prisma: {
        bot: { findUnique: vi.fn(async () => ({ spaceId: "space-1" })) },
        run: { findMany: vi.fn(async () => [{ id: "intro-run", status: "queued" }]) },
        attempt: { count: vi.fn(async () => 0) },
      },
      jobs: { cancel: vi.fn(async () => undefined) },
      runtime: { abort: vi.fn(async () => undefined) },
    } as unknown as BotIntroHarness;

    await expect(discardBotIntroRun(harness, "session", "bot-1", 40)).rejects.toThrow(
      "Bot creation intro did not stop",
    );
  });
});
