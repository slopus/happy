import { describe, expect, it, vi } from "vitest";
import type { CuaToolClient, CuaToolResult } from "./cua-host-screen.js";
import { createCuaHostScreen } from "./cua-host-screen.js";
import { HostScreenError } from "./host-screen.js";

const scope = { botId: "bot-1", signal: new AbortController().signal };
const textEdit = { name: "TextEdit", bundle_id: "com.apple.TextEdit", pid: 41, running: true };
const windowState: CuaToolResult = {
  content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
  structuredContent: {
    snapshot_id: "s0000000a",
    tree_markdown: '- [0] AXWindow "Untitled"\n  - [1] AXTextArea',
    window_title: "Untitled",
    screenshot_width: 880,
    screenshot_height: 448,
  },
};

/** A driver that answers from `handlers` and records every call. */
function driver(handlers: Record<string, (args: Record<string, unknown>) => CuaToolResult>) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const client: CuaToolClient = {
    call: async (name, args) => {
      calls.push([name, args]);
      const handler = handlers[name];
      return handler ? handler(args) : { structuredContent: {} };
    },
    close: vi.fn(async () => undefined),
  };
  const connect = vi.fn(async () => client);
  const permissions = vi.fn(async () => undefined);
  const screen = createCuaHostScreen({ connect, permissions, selfPid: 99, idleMs: 60_000 });
  return { screen, calls, client, connect, permissions };
}

const runningTextEdit = {
  list_apps: () => ({ structuredContent: { apps: [textEdit] } }),
  list_windows: () => ({
    structuredContent: {
      windows: [
        { window_id: 7, pid: 41, layer: 0, is_on_screen: false, z_index: 90, title: "Panel" },
        { window_id: 8, pid: 41, layer: 0, is_on_screen: true, z_index: 10, title: "Untitled" },
      ],
    },
  }),
  get_window_state: () => windowState,
};

describe("Cua host screen", () => {
  it("checks permissions before starting the driver, then observes the app's front window", async () => {
    const { screen, calls, connect, permissions } = driver(runningTextEdit);
    const observed = await screen.observe(scope, "textedit", { query: "Hello" });
    expect(permissions).toHaveBeenCalledBefore(connect);
    expect(observed).toEqual({
      app: "TextEdit",
      title: "Untitled",
      tree: '- [0] AXWindow "Untitled"\n  - [1] AXTextArea',
      image: { mimeType: "image/png", data: "iVBORw0KGgo=", width: 880, height: 448 },
    });
    expect(calls.at(-1)).toEqual([
      "get_window_state",
      expect.objectContaining({ pid: 41, window_id: 8, query: "Hello" }),
    ]);
    await screen.observe(scope, "TextEdit");
    expect(connect).toHaveBeenCalledOnce();
  });

  it("refuses a permission the OS has not granted without starting the driver", async () => {
    const { screen, connect, permissions } = driver(runningTextEdit);
    permissions.mockRejectedValueOnce(new HostScreenError("allow Rakazo"));
    await expect(screen.observe(scope, "TextEdit")).rejects.toThrow("allow Rakazo");
    expect(connect).not.toHaveBeenCalled();
  });

  it("drives only the exact app named, never a near match or itself", async () => {
    const { screen, calls } = driver({
      ...runningTextEdit,
      list_apps: () => ({
        structuredContent: {
          apps: [
            textEdit,
            { name: "Terminal", pid: 50, running: true },
            { name: "Rakazo", pid: 99, running: true },
          ],
        },
      }),
    });
    await expect(screen.observe(scope, "Photoshop")).rejects.toThrow(
      'No app named "Photoshop" is installed.',
    );
    await expect(screen.observe(scope, "Text")).rejects.toThrow(
      'No app is named exactly "Text". Installed apps with similar names: TextEdit.',
    );
    await expect(screen.observe(scope, "T")).rejects.toThrow("TextEdit, Terminal");
    await expect(screen.observe(scope, "Rakazo")).rejects.toThrow(
      "Rakazo can't use its own window.",
    );
    await expect(screen.observe(scope, "com.apple.textedit")).resolves.toMatchObject({
      app: "TextEdit",
    });
    expect(calls.filter(([name]) => name === "list_windows")).toHaveLength(1);
  });

  it("opens an app in the background and asks it to reopen when it shows no window", async () => {
    let launches = 0;
    const { screen, calls } = driver({
      ...runningTextEdit,
      list_apps: () => ({ structuredContent: { apps: [{ ...textEdit, pid: 0, running: false }] } }),
      launch_app: () => {
        launches += 1;
        return { structuredContent: { pid: 41 } };
      },
      list_windows: () =>
        launches < 2 ? { structuredContent: { windows: [] } } : runningTextEdit.list_windows(),
    });
    vi.useFakeTimers();
    try {
      const observed = screen.observe(scope, "TextEdit");
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(observed).resolves.toMatchObject({ app: "TextEdit" });
    } finally {
      vi.useRealTimers();
    }
    expect(calls.filter(([name]) => name === "launch_app")).toEqual([
      ["launch_app", { bundle_id: "com.apple.TextEdit" }],
      ["launch_app", { bundle_id: "com.apple.TextEdit" }],
    ]);
  });

  it("acts on element numbers from the latest observation and returns the window afterwards", async () => {
    const { screen, calls } = driver(runningTextEdit);
    await screen.observe(scope, "TextEdit");
    calls.length = 0;
    const result = await screen.act(scope, "TextEdit", [
      { kind: "click", element: 1 },
      { kind: "click", x: 10, y: 20, double: true },
      { kind: "click", element: 1, button: "right" },
      { kind: "type", text: "Hello", element: 1 },
      { kind: "set", element: 1, value: "Bold" },
      { kind: "key", key: "return" },
      { kind: "key", key: "n", modifiers: ["cmd", "shift"] },
      { kind: "scroll", direction: "down", element: 1 },
      { kind: "menu", path: ["Format", "Font", "Bold"] },
    ]);
    expect(result).toMatchObject({ completed: 9, observation: { app: "TextEdit" } });
    expect(result.error).toBeUndefined();
    const actions = calls.filter(
      ([name]) => !["list_apps", "list_windows", "get_window_state"].includes(name),
    );
    expect(actions).toEqual([
      ["click", { element_token: "s0000000a:1" }],
      ["double_click", { pid: 41, window_id: 8, x: 10, y: 20 }],
      ["click", { element_token: "s0000000a:1", button: "right" }],
      ["type_text", { pid: 41, text: "Hello", element_token: "s0000000a:1" }],
      ["set_value", { element_token: "s0000000a:1", value: "Bold" }],
      ["press_key", { pid: 41, key: "return" }],
      ["hotkey", { pid: 41, keys: ["cmd", "shift", "n"] }],
      ["scroll", { pid: 41, direction: "down", amount: 3, element_token: "s0000000a:1" }],
      ["invoke_menu", { pid: 41, window_id: 8, path: ["Format", "Font", "Bold"] }],
    ]);
  });

  it("follows the front window when an action replaces it", async () => {
    let opened = false;
    const { screen, calls } = driver({
      ...runningTextEdit,
      list_windows: () => ({
        structuredContent: {
          windows: [{ window_id: opened ? 9 : 8, pid: 41, layer: 0, is_on_screen: true }],
        },
      }),
      invoke_menu: () => {
        opened = true;
        return { structuredContent: {} };
      },
    });
    await screen.act(scope, "TextEdit", [
      { kind: "menu", path: ["File", "New"] },
      { kind: "scroll", direction: "down", x: 5, y: 5 },
    ]);
    expect(calls.find(([name]) => name === "scroll")?.[1]).toMatchObject({ window_id: 9 });
    expect(calls.at(-1)).toEqual(["get_window_state", expect.objectContaining({ window_id: 9 })]);
  });

  it("stops at the first refused action and reports why, with the window after it", async () => {
    const { screen, calls } = driver({
      ...runningTextEdit,
      type_text: () => ({ isError: true, content: [{ type: "text", text: "Nothing was sent." }] }),
    });
    const result = await screen.act(scope, "TextEdit", [
      { kind: "key", key: "tab" },
      { kind: "type", text: "Hello" },
      { kind: "key", key: "return" },
    ]);
    expect(result).toMatchObject({
      completed: 1,
      error: "Nothing was sent.",
      observation: { app: "TextEdit" },
    });
    expect(calls.filter(([name]) => name === "press_key")).toHaveLength(1);
  });

  it("keeps the count of actions that ran when the window is gone afterwards", async () => {
    let closed = false;
    const { screen } = driver({
      ...runningTextEdit,
      list_windows: () =>
        closed ? { structuredContent: { windows: [] } } : runningTextEdit.list_windows(),
      invoke_menu: () => {
        closed = true;
        return { structuredContent: {} };
      },
    });
    await expect(
      screen.act(scope, "TextEdit", [{ kind: "menu", path: ["File", "Close"] }]),
    ).resolves.toEqual({
      completed: 1,
      error: "TextEdit is open but shows no window. Ask the user to open one, then try again.",
    });
  });

  it("asks for an observation before element numbers mean anything", async () => {
    const { screen } = driver(runningTextEdit);
    const result = await screen.act(scope, "TextEdit", [{ kind: "click", element: 3 }]);
    expect(result).toMatchObject({
      completed: 0,
      error: "Observe TextEdit before using element numbers.",
    });
  });

  it("restarts a driver that stopped responding", async () => {
    const { screen, client, connect } = driver(runningTextEdit);
    const call = vi.spyOn(client, "call").mockRejectedValueOnce(new Error("EPIPE"));
    await expect(screen.observe(scope, "TextEdit")).rejects.toThrow(
      "Screen control stopped responding. Try again.",
    );
    expect(client.close).toHaveBeenCalled();
    call.mockRestore();
    await expect(screen.observe(scope, "TextEdit")).resolves.toMatchObject({ app: "TextEdit" });
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("closes the driver once it sits idle", async () => {
    vi.useFakeTimers();
    try {
      const { screen, client } = driver(runningTextEdit);
      await screen.observe(scope, "TextEdit");
      expect(client.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(client.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
