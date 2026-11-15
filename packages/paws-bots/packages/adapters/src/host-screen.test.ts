import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostComputerFrame } from "./host-computer-protocol.js";
import { hostComputerDeadlineMs } from "./host-computer-protocol.js";
import { createHostComputerRunner } from "./host-computer-runner.js";
import type { HostScreen } from "./host-screen.js";
import { HostScreenError } from "./host-screen.js";

const observation = { app: "TextEdit", tree: "- [0] AXWindow" };

describe("host screen requests", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "rakazo-screen-test-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function send(screen: HostScreen | undefined, input: unknown) {
    const runner = createHostComputerRunner({ root, screen });
    runner.setEnabled(true);
    const call = runner.begin()!;
    const frames: HostComputerFrame<unknown>[] = [];
    try {
      const outcome = await call.run(input, {
        open: () => undefined,
        write: (frame) => {
          frames.push(frame);
        },
      });
      return { outcome, frames };
    } finally {
      call.end();
      runner.close();
    }
  }

  function fakeScreen(): HostScreen & {
    observe: ReturnType<typeof vi.fn>;
    act: ReturnType<typeof vi.fn>;
  } {
    return {
      observe: vi.fn(async () => observation),
      act: vi.fn(async () => ({ completed: 1, observation })),
      close: vi.fn(async () => undefined),
    };
  }

  it("observes and acts through the computer's screen, scoped to the bot", async () => {
    const screen = fakeScreen();
    await expect(
      send(screen, { method: "screenObserve", botId: "bot-1", app: "TextEdit", query: "Save" }),
    ).resolves.toEqual({ outcome: "finished", frames: [{ value: observation }, { done: true }] });
    expect(screen.observe).toHaveBeenCalledWith(
      { botId: "bot-1", signal: expect.any(AbortSignal) },
      "TextEdit",
      { query: "Save" },
    );
    const actions = [{ kind: "menu", path: ["File", "New"] }];
    await send(screen, { method: "screenAct", botId: "bot-1", app: "TextEdit", actions });
    expect(screen.act).toHaveBeenCalledWith(expect.anything(), "TextEdit", actions);
  });

  it.each([
    { method: "screenObserve", botId: "bot-1", app: "" },
    { method: "screenAct", botId: "bot-1", app: "TextEdit", actions: [] },
    {
      method: "screenAct",
      botId: "bot-1",
      app: "TextEdit",
      actions: Array.from({ length: 25 }, () => ({ kind: "wait", ms: 1 })),
    },
    { method: "screenAct", botId: "bot-1", app: "TextEdit", actions: [{ kind: "drag" }] },
    {
      method: "screenAct",
      botId: "bot-1",
      app: "TextEdit",
      actions: [{ kind: "key", key: "q", modifiers: ["hyper"] }],
    },
  ])("rejects a malformed request %#", async (input) => {
    const screen = fakeScreen();
    await expect(send(screen, input)).resolves.toEqual({ outcome: "invalid", frames: [] });
    expect(screen.act).not.toHaveBeenCalled();
  });

  it("passes the screen's own explanations through and hides any other failure", async () => {
    const screen = fakeScreen();
    screen.observe.mockRejectedValueOnce(new HostScreenError("The user's screen is locked."));
    screen.observe.mockRejectedValueOnce(new Error("/Users/someone/secret path"));
    const request = { method: "screenObserve", botId: "bot-1", app: "TextEdit" };
    expect((await send(screen, request)).frames).toEqual([
      { error: "The user's screen is locked." },
    ]);
    expect((await send(screen, request)).frames).toEqual([
      { error: "Local computer operation failed" },
    ]);
  });

  it("says so on a computer without screen control", async () => {
    const { frames } = await send(undefined, {
      method: "screenObserve",
      botId: "bot-1",
      app: "TextEdit",
    });
    expect(frames).toEqual([{ error: "Screen control is not available on this computer." }]);
  });

  it("gives screen requests a short deadline", () => {
    expect(
      hostComputerDeadlineMs({ method: "screenObserve", botId: "bot-1", app: "TextEdit" }),
    ).toBe(120_000);
  });
});
