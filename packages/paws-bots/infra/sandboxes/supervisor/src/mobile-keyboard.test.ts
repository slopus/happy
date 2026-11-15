import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  attachMobileKeyboard,
  attachMobileTrackpad,
  isTouchBrowser,
  mobileInputChanges,
} from "../../computer/mobile-keyboard.js";
import { COMPUTER_IMAGE_CONTEXT_FILES } from "./computer-spec.js";

type TouchLike = { identifier: number; clientX: number; clientY: number };
type TouchEventLike = {
  changedTouches: TouchLike[];
  touches: TouchLike[];
  preventDefault: () => void;
  stopPropagation: () => void;
  defaultPrevented: boolean;
};

/** A fake noVNC surface: a 200x100 canvas at (0,100) inside a 200x300 free area. */
function trackpadFixture() {
  const listeners = new Map<string, (event: TouchEventLike) => void>();
  const buttonListeners = new Map<string, () => void>();
  const mouseEvents: { type: string; clientX: number; clientY: number }[] = [];
  const overlay = {
    style: { display: "none" },
    events: [] as string[],
    dispatchEvent(event: { type: string }) {
      this.events.push(event.type);
      this.style.display = "none";
      return true;
    },
  };
  const canvas = {
    getBoundingClientRect: () => ({
      left: 0,
      top: 100,
      right: 200,
      bottom: 200,
      width: 200,
      height: 100,
    }),
    dispatchEvent: (event: { type: string; clientX: number; clientY: number }) => {
      mouseEvents.push({ type: event.type, clientX: event.clientX, clientY: event.clientY });
      if (event.type === "mousedown") overlay.style.display = "";
      return true;
    },
  };
  const surface = {
    addEventListener: (type: string, listener: (event: TouchEventLike) => void) =>
      listeners.set(type, listener),
    removeEventListener: () => {},
    querySelector: () => canvas,
    classList: { toggle: () => {}, remove: () => {} },
  };
  const button = {
    hidden: true,
    addEventListener: (type: string, listener: () => void) => buttonListeners.set(type, listener),
    removeEventListener: () => {},
    setAttribute: () => {},
    classList: { toggle: () => {} },
  };
  const rfb = { viewOnly: false, showDotCursor: false };
  // noVNC's mouse capture overlay is shown after a mousedown and must receive the mouseup.
  const documentTarget = {
    getElementById: (id: string) => (id === "noVNC_mouse_capture_elem" ? overlay : null),
  };
  const detach = attachMobileTrackpad(rfb, { button, surface, documentTarget, sensitivity: 1 });
  buttonListeners.get("click")?.();
  const touch = (
    type: string,
    identifier: number,
    clientX: number,
    clientY: number,
    others: TouchLike[] = [],
    batched: TouchLike[] = [],
  ) => {
    const changed = [{ identifier, clientX, clientY }, ...batched];
    const event: TouchEventLike = {
      changedTouches: changed,
      touches: type === "touchend" || type === "touchcancel" ? others : [...changed, ...others],
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation: () => {},
    };
    listeners.get(type)?.(event);
    return event;
  };
  return { touch, mouseEvents, overlay, detach };
}

function preventableEvent(target: unknown) {
  return {
    target,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
}

function keyButton(name: string) {
  const attributes = new Map<string, string>([
    ["data-key", name],
    ["aria-pressed", "false"],
  ]);
  const classes = new Set<string>();
  return {
    getAttribute: (attr: string) => attributes.get(attr) ?? null,
    setAttribute: (attr: string, value: string) => attributes.set(attr, value),
    classList: {
      toggle: (className: string, on: boolean) => {
        if (on) classes.add(className);
        else classes.delete(className);
      },
    },
    classes,
  };
}

function keyboardFixture(
  overrides: { pasteText?: (text: string) => boolean; nativeKeys?: boolean; keyBar?: boolean } = {},
) {
  const inputListeners = new Map<string, (event: object) => void>();
  const rootListeners = new Map<string, (event: ReturnType<typeof preventableEvent>) => void>();
  const keyBarListeners = new Map<string, (event: object) => void>();
  const keys: Array<[number, string?, boolean?]> = [];
  const pasteButton = {};
  const buttons = overrides.keyBar
    ? ["Escape", "Tab", "Control", "ArrowLeft", "ArrowDown", "ArrowUp", "ArrowRight"].map(keyButton)
    : [];
  const keyBar = overrides.keyBar
    ? {
        hidden: true,
        contains: (target: unknown) => buttons.includes(target as (typeof buttons)[number]),
        addEventListener: (type: string, listener: (event: object) => void) =>
          keyBarListeners.set(type, listener),
        removeEventListener: () => {},
        querySelector: (selector: string) =>
          buttons.find((button) => selector.includes(`"${button.getAttribute("data-key")}"`)) ??
          null,
      }
    : undefined;
  const button = {
    hidden: true,
    parentElement: { contains: (target: unknown) => target === pasteButton },
    addEventListener: () => {},
    removeEventListener: () => {},
    setAttribute: () => {},
    classList: { toggle: () => {} },
    contains: () => false,
  };
  const inputAttributes = new Map([["aria-hidden", "true"]]);
  const input = {
    value: "",
    attributes: inputAttributes,
    setAttribute: (name: string, value: string) => inputAttributes.set(name, value),
    removeAttribute: (name: string) => inputAttributes.delete(name),
    addEventListener: (type: string, listener: (event: object) => void) =>
      inputListeners.set(type, listener),
    removeEventListener: () => {},
    focus: () => {},
    blur: () => {},
    setSelectionRange: () => {},
  };
  const documentTarget = {
    activeElement: input as unknown,
    documentElement: {
      style: { setProperty: () => {}, removeProperty: () => {} },
      classList: { toggle: () => {}, remove: () => {} },
      addEventListener: (
        type: string,
        listener: (event: ReturnType<typeof preventableEvent>) => void,
      ) => rootListeners.set(type, listener),
      removeEventListener: () => {},
    },
  };
  const rfb = {
    viewOnly: false,
    focusOnClick: true,
    sendKey: (keysym: number, code?: string, down?: boolean) => keys.push([keysym, code, down]),
  };
  class Keyboard {
    onkeyevent = null;
    grab() {}
    ungrab() {}
  }
  const pasteText = overrides.pasteText;
  const windowTarget: {
    __rakazoNativeKeys: boolean;
    rakazoComputerKeyboard?: {
      run: (command: {
        type: string;
        name?: string;
        text?: string;
        control?: boolean;
        count?: number;
      }) => void;
    };
  } = { __rakazoNativeKeys: overrides.nativeKeys === true };
  const detach = attachMobileKeyboard(rfb, {
    button,
    input,
    keyBar,
    Keyboard,
    backspaceKeysym: 0xff08,
    lookupKeysym: (codePoint: number) => codePoint,
    documentTarget,
    windowTarget,
    pasteText,
  });
  return {
    input,
    inputListeners,
    keys,
    pasteText,
    rootListeners,
    pasteButton,
    documentTarget,
    button,
    keyBar,
    keyBarListeners,
    buttons,
    windowTarget,
    detach,
  };
}

describe("mobile computer keyboard", () => {
  it("translates inserted and deleted text", () => {
    expect(mobileInputChanges("___", "___a", 4)).toEqual({
      backspaces: 0,
      text: "a",
    });
    expect(mobileInputChanges("___", "hi___", 2)).toEqual({
      backspaces: 3,
      text: "hi___",
    });
    expect(mobileInputChanges("___a", "___", 3)).toEqual({
      backspaces: 1,
      text: "",
    });
  });

  it("replaces corrected text instead of duplicating it", () => {
    expect(mobileInputChanges("___teh", "___the", 6)).toEqual({
      backspaces: 2,
      text: "he",
    });
  });

  it("only enables the control in touch browsers", () => {
    expect(isTouchBrowser({ maxTouchPoints: 1 }, {})).toBe(true);
    expect(isTouchBrowser({ maxTouchPoints: 0 }, { ontouchstart: null })).toBe(true);
    expect(isTouchBrowser({ maxTouchPoints: 0 }, {})).toBe(false);
  });

  it("enables a visible relative-pointer mode", () => {
    const listeners = new Map<string, () => void>();
    const classes = new Set<string>();
    const button = {
      hidden: true,
      addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
      removeEventListener: () => {},
      setAttribute: () => {},
      classList: {
        toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)),
      },
    };
    const surface = {
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelector: () => null,
      classList: { toggle: () => {}, remove: () => {} },
    };
    const rfb = { viewOnly: false, showDotCursor: false };
    const detach = attachMobileTrackpad(rfb, { button, surface, documentTarget: {} });
    listeners.get("click")?.();
    expect(button.hidden).toBe(false);
    expect(rfb.showDotCursor).toBe(true);
    expect(classes.has("active")).toBe(true);
    detach();
    expect(rfb.showDotCursor).toBe(false);
  });

  it("ships and initializes the keyboard bridge in the computer image", () => {
    const root = path.resolve(import.meta.dirname, "../../computer");
    const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
    const embed = readFileSync(path.join(root, "embed.html"), "utf8");
    const start = readFileSync(path.join(root, "start.sh"), "utf8");
    expect(dockerfile).toMatch(/mobile-keyboard\.js/);
    expect(embed).toMatch(/attachMobileKeyboard/);
    expect(embed).toMatch(/mobile-keyboard-input/);
    expect(embed).toMatch(/aria-label="Remote computer keyboard input"\s+aria-hidden="true"/);
    expect(embed).toMatch(/attachMobilePaste/);
    expect(embed).toMatch(/mobile-paste/);
    expect(embed).toMatch(/attachMobileTrackpad/);
    expect(embed).toMatch(/mobile-trackpad/);
    expect(embed).toMatch(/mobile-keyboard-open #screen/);
    expect(embed).toMatch(/mobile-key-bar/);
    expect(embed).toMatch(/data-key="Escape"/);
    expect(embed).toMatch(/__rakazoNativeKeys/);
    expect(embed).toMatch(/--mobile-visual-height/);
    const keyboard = readFileSync(path.join(root, "mobile-keyboard.js"), "utf8");
    expect(keyboard).toMatch(/rakazoComputerKeyboard/);
    expect(keyboard).toMatch(/__rakazoNativeKeys/);
    expect(start).toMatch(/mobile-keyboard\.js/);
    expect(COMPUTER_IMAGE_CONTEXT_FILES).toContain("mobile-keyboard.js");
  });

  it("exposes the hidden keyboard field to screen readers only while it is open", () => {
    const { input, inputListeners } = keyboardFixture();
    expect(input.attributes.get("aria-hidden")).toBe("true");
    inputListeners.get("focus")?.({});
    expect(input.attributes.has("aria-hidden")).toBe(false);
    inputListeners.get("blur")?.({});
    expect(input.attributes.get("aria-hidden")).toBe("true");
  });

  it("pastes host clipboard text instead of typing an insertFromPaste", () => {
    const { input, inputListeners, keys, pasteText } = keyboardFixture({
      pasteText: vi.fn(() => true),
    });
    const seed = input.value;
    input.value = `${seed}from-phone`;
    inputListeners.get("input")?.({
      target: input,
      inputType: "insertFromPaste",
    });
    expect(pasteText).toHaveBeenCalledWith("from-phone");
    expect(keys).toEqual([]);
    expect(input.value).toBe(seed);
  });

  it("forwards typed text, Enter, and special keys through the native bridge", () => {
    const { input, inputListeners, keys, windowTarget, detach } = keyboardFixture();
    const seed = input.value;
    input.value = `${seed}a\n`;
    inputListeners.get("input")?.({ target: input, inputType: "insertText" });
    expect(keys).toEqual([
      [97, undefined, undefined],
      [0xff0d, "Enter", undefined],
    ]);
    windowTarget.rakazoComputerKeyboard?.run({ type: "key", name: "Escape" });
    windowTarget.rakazoComputerKeyboard?.run({ type: "key", name: "Tab" });
    windowTarget.rakazoComputerKeyboard?.run({ type: "key", name: "ArrowUp" });
    windowTarget.rakazoComputerKeyboard?.run({ type: "char", text: "c", control: true });
    expect(keys.slice(2)).toEqual([
      [0xff1b, "Escape", undefined],
      [0xff09, "Tab", undefined],
      [0xff52, "ArrowUp", undefined],
      [0xffe3, "ControlLeft", true],
      [99, undefined, true],
      [99, undefined, false],
      [0xffe3, "ControlLeft", false],
    ]);
    detach();
    expect(windowTarget.rakazoComputerKeyboard).toBeUndefined();
  });

  it("keeps the in-page keyboard hidden when the native app supplies keys", () => {
    const { button, keyBar, keys, windowTarget } = keyboardFixture({
      nativeKeys: true,
      keyBar: true,
    });
    expect(button.hidden).toBe(true);
    expect(keyBar?.hidden).toBe(true);
    windowTarget.rakazoComputerKeyboard?.run({ type: "key", name: "ArrowLeft" });
    expect(keys).toEqual([[0xff51, "ArrowLeft", undefined]]);
  });

  it("latches Ctrl on the key bar until the next key", () => {
    const { keys, keyBarListeners, buttons, input, inputListeners } = keyboardFixture({
      keyBar: true,
    });
    const control = buttons.find((item) => item.getAttribute("data-key") === "Control");
    keyBarListeners.get("click")?.({
      target: control,
      preventDefault() {},
    });
    expect(control?.getAttribute("aria-pressed")).toBe("true");
    const seed = input.value;
    input.value = `${seed}c`;
    inputListeners.get("input")?.({ target: input, inputType: "insertText" });
    expect(keys).toEqual([
      [0xffe3, "ControlLeft", true],
      [99, undefined, true],
      [99, undefined, false],
      [0xffe3, "ControlLeft", false],
    ]);
    expect(control?.getAttribute("aria-pressed")).toBe("false");
    keyBarListeners.get("click")?.({
      target: buttons.find((item) => item.getAttribute("data-key") === "Escape"),
      preventDefault() {},
    });
    expect(keys.at(-1)).toEqual([0xff1b, "Escape", undefined]);
  });

  it("lets sibling chrome controls receive taps while the keyboard is open", () => {
    const { rootListeners, pasteButton, documentTarget, input } = keyboardFixture();
    documentTarget.activeElement = input;
    const pasteTap = preventableEvent(pasteButton);
    rootListeners.get("pointerdown")?.(pasteTap);
    expect(pasteTap.defaultPrevented).toBe(false);
    const screenTap = preventableEvent({});
    rootListeners.get("pointerdown")?.(screenTap);
    expect(screenTap.defaultPrevented).toBe(true);
  });
});

describe("mobile trackpad touches", () => {
  const stubMouseEvent = () => {
    const previous = (globalThis as { MouseEvent?: unknown }).MouseEvent;
    (globalThis as { MouseEvent?: unknown }).MouseEvent = class {
      type: string;
      clientX: number;
      clientY: number;
      constructor(type: string, init: { clientX: number; clientY: number }) {
        this.type = type;
        this.clientX = init.clientX;
        this.clientY = init.clientY;
      }
    };
    return () => {
      (globalThis as { MouseEvent?: unknown }).MouseEvent = previous;
    };
  };

  it("moves the pointer relative to a drag in the free area and clicks where it is on a tap", () => {
    const restore = stubMouseEvent();
    try {
      const fixture = trackpadFixture();
      expect(fixture.mouseEvents.at(-1)).toEqual({ type: "mousemove", clientX: 100, clientY: 150 });
      const start = fixture.touch("touchstart", 1, 50, 250);
      expect(start.defaultPrevented).toBe(true);
      fixture.touch("touchmove", 1, 70, 260);
      fixture.touch("touchend", 1, 70, 260);
      expect(fixture.mouseEvents.at(-1)).toEqual({ type: "mousemove", clientX: 120, clientY: 160 });
      fixture.touch("touchstart", 2, 30, 280);
      const end = fixture.touch("touchend", 2, 30, 280);
      expect(end.defaultPrevented).toBe(true);
      expect(fixture.mouseEvents.at(-1)).toEqual({ type: "mousedown", clientX: 120, clientY: 160 });
      expect(fixture.overlay.events).toEqual(["mouseup"]);
      expect(fixture.overlay.style.display).toBe("none");
      fixture.detach();
    } finally {
      restore();
    }
  });

  it("leaves touches on the desktop to noVNC and follows the pointer there", () => {
    const restore = stubMouseEvent();
    try {
      const fixture = trackpadFixture();
      const start = fixture.touch("touchstart", 1, 40, 120);
      expect(start.defaultPrevented).toBe(false);
      const end = fixture.touch("touchend", 1, 40, 120);
      expect(end.defaultPrevented).toBe(false);
      expect(fixture.mouseEvents.filter((event) => event.type === "mousedown")).toHaveLength(0);
      fixture.touch("touchstart", 2, 100, 250);
      fixture.touch("touchmove", 2, 110, 250);
      expect(fixture.mouseEvents.at(-1)).toEqual({ type: "mousemove", clientX: 50, clientY: 120 });
      fixture.detach();
    } finally {
      restore();
    }
  });

  it("follows a drag on the desktop so the next free-area move continues from there", () => {
    const restore = stubMouseEvent();
    try {
      const fixture = trackpadFixture();
      fixture.touch("touchstart", 1, 40, 120);
      fixture.touch("touchmove", 1, 90, 170);
      fixture.touch("touchend", 1, 90, 170);
      fixture.touch("touchstart", 2, 100, 250);
      fixture.touch("touchmove", 2, 110, 250);
      expect(fixture.mouseEvents.at(-1)).toEqual({ type: "mousemove", clientX: 100, clientY: 170 });
      fixture.detach();
    } finally {
      restore();
    }
  });

  it("ignores extra fingers during a free-area gesture and never clicks for them", () => {
    const restore = stubMouseEvent();
    try {
      const fixture = trackpadFixture();
      fixture.touch("touchstart", 1, 50, 250);
      fixture.touch("touchmove", 1, 60, 250);
      const second = fixture.touch("touchstart", 2, 150, 280, [
        { identifier: 1, clientX: 60, clientY: 250 },
      ]);
      expect(second.defaultPrevented).toBe(true);
      fixture.touch("touchmove", 2, 120, 280, [{ identifier: 1, clientX: 60, clientY: 250 }]);
      expect(fixture.mouseEvents.at(-1)).toEqual({ type: "mousemove", clientX: 110, clientY: 150 });
      fixture.touch("touchend", 2, 120, 280, [{ identifier: 1, clientX: 60, clientY: 250 }]);
      expect(fixture.mouseEvents.filter((event) => event.type === "mousedown")).toHaveLength(0);
      fixture.touch("touchmove", 1, 70, 250);
      expect(fixture.mouseEvents.at(-1)).toEqual({ type: "mousemove", clientX: 120, clientY: 150 });
      fixture.detach();
    } finally {
      restore();
    }
  });

  it("classifies every touch of a batched touchstart", () => {
    const restore = stubMouseEvent();
    try {
      const fixture = trackpadFixture();
      // One finger lands on the desktop and another in the free area in the same event.
      const start = fixture.touch(
        "touchstart",
        1,
        40,
        120,
        [],
        [{ identifier: 2, clientX: 100, clientY: 250 }],
      );
      expect(start.defaultPrevented).toBe(true);
      fixture.touch("touchmove", 2, 110, 250, [{ identifier: 1, clientX: 40, clientY: 120 }]);
      expect(fixture.mouseEvents.at(-1)).toEqual({ type: "mousemove", clientX: 50, clientY: 120 });
      fixture.detach();
    } finally {
      restore();
    }
  });

  it("starts a fresh gesture when a previous touch never reported its end", () => {
    const restore = stubMouseEvent();
    try {
      const fixture = trackpadFixture();
      fixture.touch("touchstart", 1, 50, 250);
      fixture.touch("touchmove", 1, 60, 250);
      // No touchend for touch 1. The next touch must still drive the trackpad.
      fixture.touch("touchstart", 2, 150, 280);
      fixture.touch("touchmove", 2, 140, 280);
      expect(fixture.mouseEvents.at(-1)).toEqual({ type: "mousemove", clientX: 100, clientY: 150 });
      fixture.detach();
    } finally {
      restore();
    }
  });
});
