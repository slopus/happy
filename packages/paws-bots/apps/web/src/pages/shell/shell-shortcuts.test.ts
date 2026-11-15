// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RakazoDesktop } from "../../lib/desktop";
import type { ShellShortcut, ShortcutHost } from "./shell-shortcuts";
import { cycleBotId, shellShortcut, startsTyping, useShellShortcuts } from "./shell-shortcuts";

function keyEvent(
  partial: Partial<Omit<KeyboardEvent, "target">> &
    Pick<KeyboardEvent, "key"> & { target?: EventTarget | null },
): KeyboardEvent {
  return {
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    repeat: false,
    shiftKey: false,
    isComposing: false,
    target: null,
    ...partial,
  } as KeyboardEvent;
}

const macApp: ShortcutHost = { desktop: true, apple: true };
const windowsApp: ShortcutHost = { desktop: true, apple: false };
const macBrowser: ShortcutHost = { desktop: false, apple: true };
const windowsBrowser: ShortcutHost = { desktop: false, apple: false };
const textarea = document.createElement("textarea");

describe("shellShortcut", () => {
  it("opens the command menu and the create menu with Cmd or Ctrl everywhere", () => {
    for (const host of [macApp, windowsApp, macBrowser, windowsBrowser]) {
      expect(shellShortcut(keyEvent({ key: "k", metaKey: true }), host)).toEqual({
        type: "command-menu",
      });
      expect(shellShortcut(keyEvent({ key: "K", ctrlKey: true }), host)).toEqual({
        type: "command-menu",
      });
      expect(shellShortcut(keyEvent({ key: "n", ctrlKey: true }), host)).toEqual({ type: "new" });
    }
    expect(shellShortcut(keyEvent({ key: "k" }), macApp)).toBeNull();
    expect(shellShortcut(keyEvent({ key: "k", metaKey: true, shiftKey: true }), macApp)).toBeNull();
    expect(shellShortcut(keyEvent({ key: "k", metaKey: true, altKey: true }), macApp)).toBeNull();
    expect(shellShortcut(keyEvent({ key: "k", metaKey: true, repeat: true }), macApp)).toBeNull();
  });

  it("toggles the sidebar with Cmd on Apple keyboards and Ctrl elsewhere", () => {
    expect(shellShortcut(keyEvent({ key: "b", metaKey: true }), macBrowser)).toEqual({
      type: "toggle-sidebar",
    });
    expect(shellShortcut(keyEvent({ key: "b", ctrlKey: true }), windowsBrowser)).toEqual({
      type: "toggle-sidebar",
    });
    // Ctrl+B moves the caret back a character on macOS.
    expect(shellShortcut(keyEvent({ key: "b", ctrlKey: true }), macApp)).toBeNull();
    expect(shellShortcut(keyEvent({ key: "b", metaKey: true }), windowsApp)).toBeNull();
  });

  it("focuses the composer, connects apps and toggles chat details with the primary key", () => {
    for (const [host, primary] of [
      [macBrowser, "metaKey"],
      [windowsApp, "ctrlKey"],
    ] as const) {
      expect(shellShortcut(keyEvent({ key: "i", [primary]: true }), host)).toEqual({
        type: "focus-composer",
      });
      expect(shellShortcut(keyEvent({ key: "M", [primary]: true, shiftKey: true }), host)).toEqual({
        type: "integrations",
      });
      expect(
        shellShortcut(keyEvent({ key: "<", code: "Comma", [primary]: true, shiftKey: true }), host),
      ).toEqual({ type: "chat-panel" });
    }
    expect(shellShortcut(keyEvent({ key: "i", ctrlKey: true }), macApp)).toBeNull();
    expect(shellShortcut(keyEvent({ key: "i", metaKey: true, shiftKey: true }), macApp)).toBeNull();
    expect(shellShortcut(keyEvent({ key: ",", code: "Comma", metaKey: true }), macApp)).toBeNull();
  });

  it("lists the shortcuts with Cmd/Ctrl+/ on any layout", () => {
    expect(shellShortcut(keyEvent({ key: "/", metaKey: true }), macBrowser)).toEqual({
      type: "shortcuts",
    });
    expect(
      shellShortcut(keyEvent({ key: "/", ctrlKey: true, shiftKey: true }), windowsApp),
    ).toEqual({ type: "shortcuts" });
    expect(shellShortcut(keyEvent({ key: "/", ctrlKey: true }), macBrowser)).toBeNull();
    expect(shellShortcut(keyEvent({ key: "/", metaKey: true, altKey: true }), macApp)).toBeNull();
  });

  it("starts a group chat with Cmd/Ctrl+Shift+N in the desktop app", () => {
    expect(shellShortcut(keyEvent({ key: "N", metaKey: true, shiftKey: true }), macApp)).toEqual({
      type: "new-group",
    });
    expect(
      shellShortcut(keyEvent({ key: "N", ctrlKey: true, shiftKey: true }), windowsApp),
    ).toEqual({ type: "new-group" });
    expect(
      shellShortcut(keyEvent({ key: "N", metaKey: true, shiftKey: true }), macBrowser),
    ).toBeNull();
  });

  it("leaves Find, Cmd+1–9 and history chords to the browser", () => {
    for (const [host, primary] of [
      [macBrowser, "metaKey"],
      [windowsBrowser, "ctrlKey"],
    ] as const) {
      expect(shellShortcut(keyEvent({ key: "f", [primary]: true }), host)).toBeNull();
      expect(shellShortcut(keyEvent({ key: "1", [primary]: true }), host)).toBeNull();
      expect(shellShortcut(keyEvent({ key: "[", [primary]: true }), host)).toBeNull();
    }
    expect(shellShortcut(keyEvent({ key: "ArrowLeft", altKey: true }), windowsBrowser)).toBeNull();
  });

  it("finds in the chat, searches bots and jumps to the first nine in the desktop app", () => {
    expect(shellShortcut(keyEvent({ key: "f", metaKey: true }), macApp)).toEqual({
      type: "find",
    });
    expect(shellShortcut(keyEvent({ key: "f", ctrlKey: true }), windowsApp)).toEqual({
      type: "find",
    });
    expect(shellShortcut(keyEvent({ key: "F", metaKey: true, shiftKey: true }), macApp)).toEqual({
      type: "search",
    });
    expect(
      shellShortcut(keyEvent({ key: "F", ctrlKey: true, shiftKey: true }), windowsApp),
    ).toEqual({ type: "search" });
    expect(shellShortcut(keyEvent({ key: "f", ctrlKey: true }), macApp)).toBeNull();
    expect(
      shellShortcut(keyEvent({ key: "F", metaKey: true, shiftKey: true }), macBrowser),
    ).toBeNull();
    expect(shellShortcut(keyEvent({ key: "1", metaKey: true }), macApp)).toEqual({
      type: "bot",
      index: 0,
    });
    expect(shellShortcut(keyEvent({ key: "9", ctrlKey: true }), windowsApp)).toEqual({
      type: "bot",
      index: 8,
    });
    expect(shellShortcut(keyEvent({ key: "0", metaKey: true }), macApp)).toBeNull();
    expect(shellShortcut(keyEvent({ key: "1", metaKey: true, shiftKey: true }), macApp)).toBeNull();
  });

  it("goes back and forward with each platform's own chord", () => {
    expect(shellShortcut(keyEvent({ key: "[", metaKey: true }), macApp)).toEqual({ type: "back" });
    expect(shellShortcut(keyEvent({ key: "]", metaKey: true }), macApp)).toEqual({
      type: "forward",
    });
    expect(shellShortcut(keyEvent({ key: "ArrowLeft", altKey: true }), windowsApp)).toEqual({
      type: "back",
    });
    expect(shellShortcut(keyEvent({ key: "ArrowRight", altKey: true }), windowsApp)).toEqual({
      type: "forward",
    });
    // Option+Arrow moves by word on macOS.
    expect(shellShortcut(keyEvent({ key: "ArrowLeft", altKey: true }), macApp)).toBeNull();
    expect(shellShortcut(keyEvent({ key: "[", ctrlKey: true }), windowsApp)).toBeNull();
  });

  it("switches bots with Ctrl-Tab, even while typing", () => {
    expect(
      shellShortcut(keyEvent({ key: "Tab", ctrlKey: true, target: textarea }), macApp),
    ).toEqual({ type: "next-bot" });
    expect(shellShortcut(keyEvent({ key: "Tab", ctrlKey: true, shiftKey: true }), macApp)).toEqual({
      type: "previous-bot",
    });
    expect(shellShortcut(keyEvent({ key: "Tab", metaKey: true }), macApp)).toBeNull();
    expect(shellShortcut(keyEvent({ key: "Tab", ctrlKey: true, repeat: true }), macApp)).toBeNull();
  });

  it.each([
    ["ArrowDown", "next-bot"],
    ["ArrowUp", "previous-bot"],
  ] as const)("switches bots with Cmd/Ctrl-Shift-%s outside text fields", (key, type) => {
    for (const modifier of ["metaKey", "ctrlKey"] as const) {
      const chord = { key, [modifier]: true, shiftKey: true };
      expect(shellShortcut(keyEvent(chord), macBrowser)).toEqual({ type });
      expect(shellShortcut(keyEvent({ ...chord, shiftKey: false }), macBrowser)).toBeNull();
      expect(shellShortcut(keyEvent({ ...chord, altKey: true }), macBrowser)).toBeNull();
      // There it selects to the end or the start of the text.
      expect(shellShortcut(keyEvent({ ...chord, target: textarea }), macBrowser)).toBeNull();
    }
    expect(shellShortcut(keyEvent({ key, shiftKey: true }), macBrowser)).toBeNull();
  });
});

describe("keydown without a key", () => {
  it("is neither a shortcut nor typing, as autofill sends it", () => {
    const event = keyEvent({ key: undefined as unknown as string, ctrlKey: true });
    expect(shellShortcut(event, macApp)).toBeNull();
    expect(startsTyping(event)).toBe(false);
  });
});

describe("startsTyping", () => {
  it("takes printable keys pressed outside text fields", () => {
    expect(startsTyping(keyEvent({ key: "h" }))).toBe(true);
    expect(startsTyping(keyEvent({ key: "H", shiftKey: true }))).toBe(true);
    expect(startsTyping(keyEvent({ key: "é" }))).toBe(true);
  });

  it("leaves chords, Space, named keys, composition and text fields alone", () => {
    expect(startsTyping(keyEvent({ key: "h", metaKey: true }))).toBe(false);
    expect(startsTyping(keyEvent({ key: "h", ctrlKey: true }))).toBe(false);
    expect(startsTyping(keyEvent({ key: "h", altKey: true }))).toBe(false);
    expect(startsTyping(keyEvent({ key: " " }))).toBe(false);
    expect(startsTyping(keyEvent({ key: "Enter" }))).toBe(false);
    expect(startsTyping(keyEvent({ key: "h", isComposing: true }))).toBe(false);
    expect(startsTyping(keyEvent({ key: "h", target: textarea }))).toBe(false);
  });
});

describe("cycleBotId", () => {
  const bots = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("wraps around at both ends", () => {
    expect(cycleBotId(bots, "a", 1)).toBe("b");
    expect(cycleBotId(bots, "c", 1)).toBe("a");
    expect(cycleBotId(bots, "a", -1)).toBe("c");
    expect(cycleBotId(bots, "b", -1)).toBe("a");
  });

  it("starts at an end when the active bot is not in the roster", () => {
    expect(cycleBotId(bots, undefined, 1)).toBe("a");
    expect(cycleBotId(bots, "missing", -1)).toBe("c");
    expect(cycleBotId([], undefined, 1)).toBeUndefined();
  });
});

describe("useShellShortcuts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete window.rakazoDesktop;
  });

  async function mount(run: (shortcut: ShellShortcut) => boolean, onTyping = () => {}) {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const root = createRoot(document.createElement("div"));
    function Probe() {
      useShellShortcuts({ run, onTyping });
      return null;
    }
    await act(async () => root.render(createElement(Probe)));
    return () => act(async () => root.unmount());
  }

  it("stops a key only when its shortcut applied", async () => {
    const applies = vi.fn(() => true);
    const unmount = await mount(applies);
    const press = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, cancelable: true });
    window.dispatchEvent(press);
    expect(applies).toHaveBeenCalledWith({ type: "command-menu" });
    expect(press.defaultPrevented).toBe(true);
    await unmount();

    const unmountIgnored = await mount(() => false);
    const ignored = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, cancelable: true });
    window.dispatchEvent(ignored);
    expect(ignored.defaultPrevented).toBe(false);
    await unmountIgnored();
  });

  it("hands printable keys to onTyping without stopping them", async () => {
    const run = vi.fn(() => true);
    const onTyping = vi.fn();
    const unmount = await mount(run, onTyping);
    const press = new KeyboardEvent("keydown", { key: "h", cancelable: true });
    window.dispatchEvent(press);
    expect(onTyping).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    expect(press.defaultPrevented).toBe(false);
    await unmount();
  });

  it("runs known desktop menu commands and ignores the rest", async () => {
    let send: ((command: string) => void) | undefined;
    const stop = vi.fn();
    window.rakazoDesktop = {
      platform: "linux",
      menu: {
        onCommand: (listener: (command: string) => void) => {
          send = listener;
          return stop;
        },
      },
    } as unknown as RakazoDesktop;
    const run = vi.fn(() => true);
    const unmount = await mount(run);
    send?.("search");
    send?.("format-disk");
    expect(run.mock.calls).toEqual([[{ type: "search" }]]);
    await unmount();
    expect(stop).toHaveBeenCalled();
  });
});
