import { describe, expect, it, vi } from "vitest";
import type { AgentDesktopEnvelope } from "./agent-desktop-host-screen.js";
import {
  agentDesktopCli,
  createAgentDesktopHostScreen,
  SCREEN_DRIVER_BLOCKED_MESSAGE,
} from "./agent-desktop-host-screen.js";
import { HOST_SCREEN_MAX_ELEMENTS, HostScreenError } from "./host-screen.js";

const scope = { botId: "bot-1", signal: new AbortController().signal };
const notepad = [
  { id: "w-7", title: "Find", app_name: "notepad.exe", pid: 41, minimized: true },
  { id: "w-8", title: "Untitled - Notepad", app_name: "notepad.exe", pid: 41 },
  { id: "w-9", title: "Rakazo", app_name: "Rakazo.exe", pid: 99 },
  { id: "w-10", title: "Notes", app_name: "notes-sync.exe", pid: 50 },
];
const snapshot = {
  snapshot_id: "s0000000a",
  complete: true,
  window: { id: "w-8", title: "Untitled - Notepad" },
  tree: {
    role: "window",
    name: "Untitled - Notepad",
    children: [
      { ref_id: "@s0000000a:e1", role: "textfield", name: "Text editor", value: "Hi" },
      { ref_id: "@s0000000a:e2", role: "menuitem", name: "File", states: ["collapsed"] },
      { role: "statictext", name: "Ln 1, Col 1" },
    ],
  },
};
const screenshot = { data: "iVBORw0KGgo=", format: "png", width: 880, height: 448 };

type Handler = (args: readonly string[]) => AgentDesktopEnvelope;
const ok = (data: unknown): AgentDesktopEnvelope => ({ ok: true, data });
const refused = (code: string, retry = "safe", message?: string): AgentDesktopEnvelope => ({
  ok: false,
  error: { code, ...(message ? { message } : {}), disposition: { retry } },
});

/** A CLI that answers each command from `handlers` and records every call. */
function cli(handlers: Record<string, Handler> = {}) {
  const calls: string[][] = [];
  const all: Record<string, Handler> = {
    "list-windows": () => ok(notepad),
    snapshot: () => ok(snapshot),
    screenshot: () => ok(screenshot),
    ...handlers,
  };
  const run = vi.fn(async (args: readonly string[]) => {
    calls.push([...args]);
    return all[args[0]!]?.(args) ?? ok({ disposition: { delivery: "delivered_unverified" } });
  });
  const screen = createAgentDesktopHostScreen({ run, selfPid: 99 });
  const acted = () =>
    calls.filter(([name]) => !["list-windows", "snapshot", "screenshot"].includes(name!));
  return { screen, calls, run, acted };
}

describe("agent-desktop host screen", () => {
  it("observes the app's front restored window as numbered rows and a screenshot", async () => {
    const { screen, calls } = cli();
    await expect(screen.observe(scope, "Notepad")).resolves.toEqual({
      app: "notepad",
      title: "Untitled - Notepad",
      tree: [
        '- window "Untitled - Notepad"',
        '  - [1] textfield "Text editor" = "Hi"',
        '  - [2] menuitem "File" (collapsed)',
        '  - statictext "Ln 1, Col 1"',
      ].join("\n"),
      image: { mimeType: "image/png", data: "iVBORw0KGgo=", width: 880, height: 448 },
    });
    expect(calls).toContainEqual(
      expect.arrayContaining(["snapshot", "--window-id", "w-8", "--compact"]),
    );
    expect(calls).toContainEqual(["screenshot", "--window-id", "w-8"]);
  });

  it("narrows rows to a query without letting it read as a flag", async () => {
    const { screen, calls } = cli({
      find: () =>
        ok({
          snapshot_id: "s0000000b",
          matches: [{ ref_id: "@s0000000b:e4", role: "button", name: "Save" }],
        }),
    });
    const observed = await screen.observe(scope, "notepad.exe", { query: "--save" });
    expect(observed.tree).toBe('- [4] button "Save"');
    expect(calls).toContainEqual(expect.arrayContaining(["find", "--text=--save"]));
  });

  it("drives only the exact program named, never a near match or itself", async () => {
    const { screen, calls } = cli({ launch: () => refused("APP_NOT_FOUND") });
    await expect(screen.observe(scope, "Photoshop")).rejects.toThrow(
      'No app named "Photoshop" is open. Ask the user to open it, then try again.',
    );
    await expect(screen.observe(scope, "note")).rejects.toThrow(
      'No open app is named exactly "note". Open apps with similar names: notepad, notes-sync.',
    );
    await expect(screen.observe(scope, "rakazo")).rejects.toThrow(
      "Rakazo can't use its own window.",
    );
    expect(calls.filter(([name]) => name === "launch")).toEqual([
      ["launch", "--", "Photoshop"],
      ["launch", "--", "note"],
    ]);
  });

  it("opens a program that isn't running and waits for its window", async () => {
    let launched = false;
    const { screen } = cli({
      "list-windows": () => ok(launched ? notepad : []),
      launch: () => {
        launched = true;
        return ok({ app: "notepad", pid: 41 });
      },
    });
    await expect(screen.observe(scope, "notepad")).resolves.toMatchObject({ app: "notepad" });
  });

  it("asks the user to restore a minimized window rather than raising it", async () => {
    const { screen } = cli({ "list-windows": () => ok([notepad[0]]) });
    await expect(screen.observe(scope, "notepad")).rejects.toThrow(
      "notepad is minimized. Ask the user to restore its window, then try again.",
    );
  });

  it("acts headlessly on element numbers from the latest observation", async () => {
    const { screen, acted } = cli({
      find: (args) =>
        ok({
          snapshot_id: "s0000000c",
          match: {
            ref_id: args.includes("--surface") ? "@s0000000c:e9" : "@s0000000c:e5",
            role: "menuitem",
          },
        }),
    });
    await screen.observe(scope, "notepad");
    const result = await screen.act(scope, "notepad", [
      { kind: "click", element: 2 },
      { kind: "set", element: 1, value: "-Hello" },
      { kind: "key", key: "S", modifiers: ["cmd", "ctrl", "shift"] },
      { kind: "scroll", direction: "down", element: 1 },
      { kind: "scroll", direction: "up", amount: 5 },
      { kind: "menu", path: ["Edit", "Select All"] },
    ]);
    expect(result).toMatchObject({ completed: 6, observation: { app: "notepad" } });
    expect(result.error).toBeUndefined();
    expect(acted()).toEqual([
      ["click", "--", "@s0000000a:e2"],
      ["set-value", "--", "@s0000000a:e1", "-Hello"],
      ["press", "--window-id", "w-8", "--", "ctrl+shift+s"],
      ["scroll", "--direction", "down", "--amount", "3", "--", "@s0000000a:e1"],
      ["find", "--window-id", "w-8", "--role", "scrollarea", "--first"],
      ["scroll", "--direction", "up", "--amount", "5", "--", "@s0000000c:e5"],
      ["find", "--window-id", "w-8", "--role", "menuitem", "--name=Edit", "--exact", "--first"],
      ["click", "--", "@s0000000c:e5"],
      [
        "find",
        "--window-id",
        "w-8",
        "--surface",
        "menu",
        "--name=Select All",
        "--exact",
        "--first",
      ],
      ["click", "--", "@s0000000c:e9"],
    ]);
  });

  it("refuses gestures that would take the pointer or keyboard, and says what works instead", async () => {
    const { screen, acted } = cli();
    await screen.observe(scope, "notepad");
    for (const [action, message] of [
      [{ kind: "click", x: 10, y: 20 }, "click an element number"],
      [{ kind: "click", element: 1, double: true }, "double and right clicks"],
      [{ kind: "click", element: 1, button: "right" }, "double and right clicks"],
      [{ kind: "type", text: "Hello", element: 1 }, "Use set with the field's whole new text"],
      [{ kind: "key", key: "a", element: 1 }, "Leave out element"],
      [{ kind: "scroll", direction: "down", x: 5, y: 5 }, "scroll an element number"],
    ] as const) {
      const result = await screen.act(scope, "notepad", [action]);
      expect(result).toMatchObject({ completed: 0, error: expect.stringContaining(message) });
    }
    expect(acted()).toEqual([]);
  });

  it("picks a pop-up's choice by name when it takes no value", async () => {
    const { screen, acted } = cli({ "set-value": () => refused("ACTION_NOT_SUPPORTED") });
    await screen.observe(scope, "notepad");
    await expect(
      screen.act(scope, "notepad", [{ kind: "set", element: 1, value: "UTF-8" }]),
    ).resolves.toMatchObject({ completed: 1 });
    expect(acted().at(-1)).toEqual(["select", "--", "@s0000000a:e1", "UTF-8"]);
  });

  it("stops at the first refused action, says whether it may have landed, and shows the window", async () => {
    const { screen, acted } = cli({
      click: () => refused("TIMEOUT", "unsafe", "chain deadline"),
      "set-value": () => refused("STALE_REF"),
    });
    await screen.observe(scope, "notepad");
    const stale = await screen.act(scope, "notepad", [
      { kind: "set", element: 1, value: "Hi" },
      { kind: "click", element: 2 },
    ]);
    expect(stale).toMatchObject({
      completed: 0,
      error:
        "notepad changed since the last observation. Observe it again and use the new element numbers.",
      observation: { app: "notepad" },
    });
    expect(acted()).toHaveLength(1);
    const uncertain = await screen.act(scope, "notepad", [{ kind: "click", element: 2 }]);
    expect(uncertain.error).toBe(
      "notepad didn't respond in time. The element may be disabled or still loading. It may have taken effect; check before repeating it.",
    );
  });

  it("keeps the CLI's internals out of what the bot reads", async () => {
    const { screen } = cli({
      snapshot: () => refused("INTERNAL", "safe", "private file parent C:\\Users\\someone"),
    });
    await expect(screen.observe(scope, "notepad")).rejects.toThrow(
      "Screen control failed. Try again.",
    );
  });

  it("keeps the count of actions that ran when the window is gone afterwards", async () => {
    let closed = false;
    const { screen } = cli({
      "list-windows": () => ok(closed ? [] : notepad),
      launch: () => refused("APP_NOT_FOUND"),
      press: () => {
        closed = true;
        return ok({});
      },
    });
    await expect(
      screen.act(scope, "notepad", [{ kind: "key", key: "w", modifiers: ["cmd"] }]),
    ).resolves.toEqual({
      completed: 1,
      error: 'No app named "notepad" is open. Ask the user to open it, then try again.',
    });
  });

  it("asks for an observation before element numbers mean anything", async () => {
    const { screen } = cli();
    await expect(
      screen.act(scope, "notepad", [{ kind: "click", element: 3 }]),
    ).resolves.toMatchObject({
      completed: 0,
      error: "Observe notepad before using element numbers.",
    });
  });

  it("caps the rows and says the rest were cut off", async () => {
    const children = Array.from({ length: HOST_SCREEN_MAX_ELEMENTS + 5 }, (_, index) => ({
      ref_id: `@s0000000a:e${index}`,
      role: "button",
    }));
    const { screen } = cli({
      snapshot: () => ok({ ...snapshot, tree: { role: "window", children } }),
    });
    const { tree } = await screen.observe(scope, "notepad");
    expect(tree.split("\n")).toHaveLength(HOST_SCREEN_MAX_ELEMENTS + 1);
    expect(tree).toMatch(/Some rows were cut off/);
  });

  it("shrinks a large screenshot and still observes a window that refuses capture", async () => {
    const fitImage = vi.fn(() => ({ png: Buffer.from("small"), width: 1568, height: 784 }));
    const run = vi.fn(async (args: readonly string[]) =>
      args[0] === "list-windows"
        ? ok(notepad)
        : args[0] === "snapshot"
          ? ok(snapshot)
          : ok({ ...screenshot, width: 3200, height: 1600 }),
    );
    const screen = createAgentDesktopHostScreen({ run, selfPid: 99, fitImage });
    await expect(screen.observe(scope, "notepad")).resolves.toMatchObject({
      image: { data: Buffer.from("small").toString("base64"), width: 1568, height: 784 },
    });
    expect(fitImage).toHaveBeenCalledWith(expect.any(Buffer), 1568);
    const { screen: refusing } = cli({ screenshot: () => refused("PERM_DENIED") });
    const observed = await refusing.observe(scope, "notepad");
    expect(observed.image).toBeUndefined();
    expect(observed.tree).toContain("[1]");
  });

  it("says screen control stopped responding when the CLI prints no envelope", async () => {
    const { screen, run } = cli();
    run.mockRejectedValueOnce(new Error("exit 3221225477"));
    await expect(screen.observe(scope, "notepad")).rejects.toThrow(
      "Screen control stopped responding. Try again.",
    );
  });
});

describe("agent-desktop CLI", () => {
  it("names the likely cause when Windows won't start the driver", async () => {
    const run = agentDesktopCli({
      command: async () => "/missing/agent-desktop.exe",
      home: "/missing",
    });
    const result = run(["version"], new AbortController().signal);
    await expect(result).rejects.toThrow(HostScreenError);
    await expect(result).rejects.toThrow(SCREEN_DRIVER_BLOCKED_MESSAGE);
  });

  it("reads the envelope printed with a refusal's exit code", async () => {
    const run = agentDesktopCli({ command: async () => process.execPath, home: "/missing" });
    const script = `console.log(JSON.stringify({ ok: false, error: { code: "STALE_REF", home: process.env.AGENT_DESKTOP_HOME } })); process.exit(1)`;
    await expect(run(["-e", script], new AbortController().signal)).resolves.toEqual({
      ok: false,
      error: { code: "STALE_REF", home: "/missing" },
    });
  });
});
