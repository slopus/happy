import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  attachHostClipboardPaste,
  attachMobilePaste,
  attachRemoteClipboardCopy,
  clipboardTextFromPaste,
  isPasteChord,
  pasteHostText,
  readHostClipboardText,
  releaseModifierKeys,
  sendRemotePaste,
} from "../../computer/clipboard-bridge.js";
import { COMPUTER_IMAGE_CONTEXT_FILES } from "./computer-spec.js";

describe("host clipboard paste bridge", () => {
  it("detects Ctrl/Cmd+V and ignores other chords", () => {
    expect(isPasteChord({ ctrlKey: true, code: "KeyV", key: "v" })).toBe(true);
    expect(isPasteChord({ metaKey: true, code: "KeyV", key: "v" })).toBe(true);
    expect(isPasteChord({ ctrlKey: true, metaKey: true, code: "KeyV", key: "V" })).toBe(true);
    expect(isPasteChord({ ctrlKey: true, code: "KeyC", key: "c" })).toBe(false);
    expect(isPasteChord({ altKey: true, ctrlKey: true, code: "KeyV", key: "v" })).toBe(false);
    expect(isPasteChord({ code: "KeyV", key: "v" })).toBe(false);
  });

  it("blocks repeated Ctrl/Cmd+V keydowns so noVNC cannot see an unmatched KeyV", () => {
    const listeners = new Map<string, (event: object) => void>();
    const target = {
      addEventListener: (type: string, listener: (event: object) => void) => {
        listeners.set(type, listener);
      },
      removeEventListener: (type: string) => {
        listeners.delete(type);
      },
    };
    attachHostClipboardPaste(
      { viewOnly: false, clipboardPasteFrom: vi.fn(), sendKey: vi.fn() },
      { target },
    );
    const stopPropagation = vi.fn();
    listeners.get("keydown")?.({
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      repeat: true,
      code: "KeyV",
      key: "v",
      stopPropagation,
    });
    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it("reads plain text from a paste event", () => {
    expect(
      clipboardTextFromPaste({
        clipboardData: {
          getData: (type: string) => (type === "text/plain" ? "secret" : ""),
        },
      }),
    ).toBe("secret");
    expect(
      clipboardTextFromPaste({
        clipboardData: {
          getData: (type: string) => (type === "text" ? "fallback" : ""),
        },
      }),
    ).toBe("fallback");
    expect(clipboardTextFromPaste({})).toBe("");
  });

  it("releases host modifiers including noVNC macOS remaps, then pastes with Linux Ctrl+V", () => {
    const keys: Array<[number, string, boolean | undefined]> = [];
    const sendKey = (keysym: number, code: string, down?: boolean) => {
      keys.push([keysym, code, down]);
    };
    releaseModifierKeys(sendKey);
    expect(keys).toEqual([
      [0xffe3, "ControlLeft", false],
      [0xffe4, "ControlRight", false],
      [0xffe9, "AltLeft", false],
      [0xffea, "AltRight", false],
      [0xffeb, "MetaLeft", false],
      [0xffec, "MetaRight", false],
      [0xff7e, "AltLeft", false],
      [0xfe03, "AltRight", false],
    ]);
    keys.length = 0;
    sendRemotePaste(sendKey);
    expect(keys).toEqual([
      [0xffe3, "ControlLeft", true],
      [0x76, "KeyV", true],
      [0x76, "KeyV", false],
      [0xffe3, "ControlLeft", false],
    ]);
  });

  it("syncs host text into RFB then sends a remote paste", () => {
    const keys: Array<[number, string, boolean | undefined]> = [];
    const rfb = {
      viewOnly: false,
      _rfbConnectionState: "connected",
      clipboardPasteFrom: vi.fn(),
      sendKey: (keysym: number, code: string, down?: boolean) => {
        keys.push([keysym, code, down]);
      },
    };
    expect(pasteHostText(rfb, "agent-password")).toBe(true);
    expect(rfb.clipboardPasteFrom).toHaveBeenCalledWith("agent-password");
    expect(keys[0]).toEqual([0xffe3, "ControlLeft", false]);
    expect(keys).toContainEqual([0xffe9, "AltLeft", false]);
    expect(keys.at(-4)).toEqual([0xffe3, "ControlLeft", true]);
    expect(keys.at(-3)).toEqual([0x76, "KeyV", true]);
    expect(pasteHostText({ ...rfb, viewOnly: true }, "x")).toBe(false);
    expect(pasteHostText(rfb, "")).toBe(false);
    expect(pasteHostText({ ...rfb, _rfbConnectionState: "connecting" }, "x")).toBe(false);
    expect(pasteHostText({ ...rfb, _rfbConnectionState: "disconnected" }, "x")).toBe(false);
  });

  it("does not swallow paste while the RFB session is still connecting", () => {
    const listeners = new Map<string, (event: object) => void>();
    const target = {
      addEventListener: (type: string, listener: (event: object) => void) => {
        listeners.set(type, listener);
      },
      removeEventListener: (type: string) => {
        listeners.delete(type);
      },
    };
    const rfb = {
      viewOnly: false,
      _rfbConnectionState: "connecting",
      clipboardPasteFrom: vi.fn(),
      sendKey: vi.fn(),
    };
    attachHostClipboardPaste(rfb, { target });
    const preventDefault = vi.fn();
    const pasteStop = vi.fn();
    listeners.get("paste")?.({
      clipboardData: {
        getData: (type: string) => (type === "text/plain" ? "from-host" : ""),
      },
      preventDefault,
      stopPropagation: pasteStop,
    });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(pasteStop).not.toHaveBeenCalled();
    expect(rfb.clipboardPasteFrom).not.toHaveBeenCalled();
  });

  it("intercepts paste chords and applies host clipboard text", () => {
    const listeners = new Map<string, (event: object) => void>();
    const target = {
      addEventListener: (type: string, listener: (event: object) => void) => {
        listeners.set(type, listener);
      },
      removeEventListener: (type: string) => {
        listeners.delete(type);
      },
    };
    const rfb = {
      viewOnly: false,
      _rfbConnectionState: "connected",
      clipboardPasteFrom: vi.fn(),
      sendKey: vi.fn(),
    };
    const detach = attachHostClipboardPaste(rfb, { target });

    const keydown = listeners.get("keydown");
    const paste = listeners.get("paste");
    expect(keydown).toBeTypeOf("function");
    expect(paste).toBeTypeOf("function");

    const stopPropagation = vi.fn();
    keydown?.({
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      repeat: false,
      code: "KeyV",
      key: "v",
      stopPropagation,
    });
    expect(stopPropagation).toHaveBeenCalledOnce();

    const preventDefault = vi.fn();
    const pasteStop = vi.fn();
    paste?.({
      clipboardData: {
        getData: (type: string) => (type === "text/plain" ? "from-host" : ""),
      },
      preventDefault,
      stopPropagation: pasteStop,
    });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(pasteStop).toHaveBeenCalledOnce();
    expect(rfb.clipboardPasteFrom).toHaveBeenCalledWith("from-host");
    expect(rfb.sendKey).toHaveBeenCalled();

    detach();
    expect(listeners.size).toBe(0);
  });

  it("ships the bridge next to embed.html in the computer image", () => {
    const root = path.resolve(import.meta.dirname, "../../computer");
    const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
    const embed = readFileSync(path.join(root, "embed.html"), "utf8");
    const start = readFileSync(path.join(root, "start.sh"), "utf8");
    expect(dockerfile).toMatch(/clipboard-bridge\.js/);
    expect(embed).toMatch(/attachHostClipboardPaste/);
    expect(embed).toMatch(/attachRemoteClipboardCopy/);
    expect(embed).toMatch(/attachMobilePaste/);
    expect(embed).toMatch(/id="mobile-paste"/);
    expect(embed).toMatch(/clipboard-bridge\.js/);
    expect(start).toMatch(/clipboard-bridge\.js/);
    expect(COMPUTER_IMAGE_CONTEXT_FILES).toContain("clipboard-bridge.js");
  });
});

describe("mobile paste control", () => {
  const connectedRfb = () => ({
    viewOnly: false,
    _rfbConnectionState: "connected",
    clipboardPasteFrom: vi.fn(),
    sendKey: vi.fn(),
  });

  const pasteButton = () => {
    const listeners = new Map<string, (event: object) => void>();
    const button = {
      hidden: true,
      addEventListener: (type: string, listener: (event: object) => void) => {
        listeners.set(type, listener);
      },
      removeEventListener: (type: string, _listener: (event: object) => void) => {
        listeners.delete(type);
      },
    };
    return { button, listeners };
  };

  const pasteTarget = (value = "_________") => ({
    value,
    focus: vi.fn(),
    blur: vi.fn(),
    setSelectionRange: vi.fn(),
  });

  it("reads host clipboard text and treats denial as unavailable", async () => {
    expect(await readHostClipboardText({ readText: async () => "from-phone" })).toBe("from-phone");
    expect(await readHostClipboardText({ readText: async () => "" })).toBe("");
    expect(
      await readHostClipboardText({
        readText: async () => {
          throw new Error("denied");
        },
      }),
    ).toBe(null);
    expect(await readHostClipboardText({})).toBe(null);
    expect(await readHostClipboardText(null)).toBe(null);
  });

  it("pastes clipboard text from a Paste tap", async () => {
    const { button, listeners } = pasteButton();
    const rfb = connectedRfb();
    const fallbackFocus = pasteTarget();
    const detach = attachMobilePaste(rfb, {
      button,
      clipboard: { readText: async () => "from-phone" },
      fallbackFocus,
    });
    expect(button.hidden).toBe(false);
    await listeners.get("click")?.({});
    expect(rfb.clipboardPasteFrom).toHaveBeenCalledWith("from-phone");
    expect(fallbackFocus.blur).toHaveBeenCalledOnce();
    detach();
    expect(listeners.size).toBe(0);
  });

  it("focuses the paste target before the clipboard read settles", async () => {
    const { button, listeners } = pasteButton();
    const rfb = connectedRfb();
    const fallbackFocus = pasteTarget("___");
    let settle: ((value: string) => void) | undefined;
    attachMobilePaste(rfb, {
      button,
      clipboard: {
        readText: () =>
          new Promise((resolve) => {
            settle = resolve;
          }),
      },
      fallbackFocus,
    });
    const pending = listeners.get("click")?.({});
    expect(fallbackFocus.focus).toHaveBeenCalledOnce();
    expect(fallbackFocus.setSelectionRange).toHaveBeenCalledWith(3, 3);
    expect(rfb.clipboardPasteFrom).not.toHaveBeenCalled();
    settle?.("from-phone");
    await pending;
    expect(rfb.clipboardPasteFrom).toHaveBeenCalledWith("from-phone");
    expect(fallbackFocus.blur).toHaveBeenCalledOnce();
  });

  it("keeps the prepared paste target focused when the clipboard API is unavailable", async () => {
    const { button, listeners } = pasteButton();
    const rfb = connectedRfb();
    const fallbackFocus = pasteTarget("___");
    attachMobilePaste(rfb, {
      button,
      clipboard: {
        readText: async () => {
          throw new Error("denied");
        },
      },
      fallbackFocus,
    });
    await listeners.get("click")?.({});
    expect(rfb.clipboardPasteFrom).not.toHaveBeenCalled();
    expect(fallbackFocus.focus).toHaveBeenCalledOnce();
    expect(fallbackFocus.setSelectionRange).toHaveBeenCalledWith(3, 3);
    expect(fallbackFocus.blur).not.toHaveBeenCalled();
  });

  it("does not show Paste in view-only sessions", () => {
    const button = { hidden: true, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    attachMobilePaste({ viewOnly: true }, { button });
    expect(button.hidden).toBe(true);
    expect(button.addEventListener).not.toHaveBeenCalled();
  });
});

describe("remote clipboard copy", () => {
  const rfbTarget = () => {
    const listeners = new Map<string, (event: object) => void>();
    const rfb = {
      addEventListener: (type: string, listener: (event: object) => void) => {
        listeners.set(type, listener);
      },
      removeEventListener: (type: string) => {
        listeners.delete(type);
      },
    };
    return { rfb, listeners };
  };

  it("writes remote cut text to the host clipboard", () => {
    const { rfb, listeners } = rfbTarget();
    const writeText = vi.fn(async (_text: string) => {});
    const detach = attachRemoteClipboardCopy(rfb, { clipboard: { writeText } });
    listeners.get("clipboard")?.({ detail: { text: "otp-482991" } });
    expect(writeText).toHaveBeenCalledWith("otp-482991");
    detach();
    expect(listeners.size).toBe(0);
  });

  it("ignores events without text", () => {
    const { rfb, listeners } = rfbTarget();
    const writeText = vi.fn(async (_text: string) => {});
    attachRemoteClipboardCopy(rfb, { clipboard: { writeText } });
    listeners.get("clipboard")?.({});
    listeners.get("clipboard")?.({ detail: {} });
    expect(writeText).not.toHaveBeenCalled();
  });

  it("does not attach when the clipboard write API is missing", () => {
    const { rfb, listeners } = rfbTarget();
    const detach = attachRemoteClipboardCopy(rfb, { clipboard: {} });
    expect(listeners.size).toBe(0);
    expect(() => detach()).not.toThrow();
    expect(() =>
      attachRemoteClipboardCopy(null, { clipboard: { writeText: vi.fn() } }),
    ).not.toThrow();
  });

  it("swallows clipboard write denials", async () => {
    const { rfb, listeners } = rfbTarget();
    const writeText = vi.fn(async (_text: string) => {
      throw new Error("denied");
    });
    attachRemoteClipboardCopy(rfb, { clipboard: { writeText } });
    listeners.get("clipboard")?.({ detail: { text: "secret" } });
    // Let the rejection settle; it must not surface as unhandled.
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("secret"));
  });
});
