/**
 * Clipboard bridge for the chrome-less noVNC embed.
 *
 * Host → sandbox: Debian noVNC 1.3 only syncs clipboard from the full
 * vnc.html panel. Without this bridge, Ctrl/Cmd+V only forwarded keys: on
 * macOS Cmd+V became Super+V (no paste on Linux), and the remote CLIPBOARD
 * stayed empty.
 * Sandbox → host: noVNC reports remote CLIPBOARD changes as a "clipboard"
 * event, but nothing writes them to the host clipboard without a listener.
 */

export const KEYSYM = {
  Control_L: 0xffe3,
  Control_R: 0xffe4,
  Alt_L: 0xffe9,
  Alt_R: 0xffea,
  Super_L: 0xffeb,
  Super_R: 0xffec,
  Mode_switch: 0xff7e,
  ISO_Level3_Shift: 0xfe03,
  v: 0x76,
};

/** @param {{ ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean, code?: string, key?: string }} event */
export function isPasteChord(event) {
  if (!event || event.altKey) return false;
  if (!(event.ctrlKey || event.metaKey)) return false;
  return event.code === "KeyV" || event.key === "v" || event.key === "V";
}

/** @param {{ clipboardData?: DataTransfer | null }} event */
export function clipboardTextFromPaste(event) {
  const data = event?.clipboardData;
  if (!data) return "";
  return data.getData("text/plain") || data.getData("text") || "";
}

/** True when noVNC RFB can accept clipboard and key events. */
export function isRfbConnected(rfb) {
  const state = rfb?._rfbConnectionState;
  return !state || state === "connected";
}

/**
 * Release modifiers that may still be down from the host paste chord.
 * noVNC 1.3 remaps macOS MetaLeft→Alt_L and MetaRight→Super_L (and Alt→
 * Mode_switch / ISO_Level3_Shift), so release those keysyms too.
 * @param {(keysym: number, code: string, down?: boolean) => void} sendKey
 */
export function releaseModifierKeys(sendKey) {
  sendKey(KEYSYM.Control_L, "ControlLeft", false);
  sendKey(KEYSYM.Control_R, "ControlRight", false);
  sendKey(KEYSYM.Alt_L, "AltLeft", false);
  sendKey(KEYSYM.Alt_R, "AltRight", false);
  sendKey(KEYSYM.Super_L, "MetaLeft", false);
  sendKey(KEYSYM.Super_R, "MetaRight", false);
  sendKey(KEYSYM.Mode_switch, "AltLeft", false);
  sendKey(KEYSYM.ISO_Level3_Shift, "AltRight", false);
}

/** Send Linux Ctrl+V so the focused remote app pastes from CLIPBOARD. */
export function sendRemotePaste(sendKey) {
  sendKey(KEYSYM.Control_L, "ControlLeft", true);
  sendKey(KEYSYM.v, "KeyV", true);
  sendKey(KEYSYM.v, "KeyV", false);
  sendKey(KEYSYM.Control_L, "ControlLeft", false);
}

/**
 * Sync host paste into the RFB session, then paste into the remote desktop.
 * @param {{ viewOnly?: boolean, clipboardPasteFrom?: (text: string) => void, sendKey?: Function, _rfbConnectionState?: string }} rfb
 * @param {string} text
 */
export function pasteHostText(rfb, text) {
  if (!rfb || rfb.viewOnly || !text || !isRfbConnected(rfb)) return false;
  const sendKey = rfb.sendKey?.bind(rfb);
  if (!sendKey || typeof rfb.clipboardPasteFrom !== "function") return false;
  releaseModifierKeys(sendKey);
  rfb.clipboardPasteFrom(text);
  sendRemotePaste(sendKey);
  return true;
}

/**
 * Read plain text from the host clipboard API.
 * Returns null when the API is missing or denied so callers can fall back to a
 * focusable paste target. An empty clipboard is "".
 * @param {{ readText?: () => Promise<string> } | null | undefined} [clipboard]
 */
export async function readHostClipboardText(clipboard = globalThis.navigator?.clipboard) {
  if (!clipboard || typeof clipboard.readText !== "function") return null;
  try {
    return (await clipboard.readText()) || "";
  } catch {
    return null;
  }
}

/**
 * Focus a paste fallback during the tap and park the caret after any sentinel
 * so OS paste cannot treat those characters as clipboard text.
 * @param {{ focus?: () => void, value?: string, setSelectionRange?: (start: number, end: number) => void } | null | undefined} target
 */
function focusPasteTarget(target) {
  if (!target || typeof target.focus !== "function") return;
  target.focus();
  if (typeof target.value !== "string") return;
  const length = target.value.length;
  target.setSelectionRange?.(length, length);
}

/**
 * Touch Paste control: one tap reads the host clipboard and pastes through the
 * RFB bridge. When the clipboard API is unavailable, focus a paste target so
 * the existing `paste` listener can fire without a modifier chord.
 * @param {{ viewOnly?: boolean, clipboardPasteFrom?: (text: string) => void, sendKey?: Function, _rfbConnectionState?: string }} rfb
 * @param {{ button?: HTMLElement | null, clipboard?: { readText?: () => Promise<string> }, fallbackFocus?: { focus?: () => void, blur?: () => void, value?: string, setSelectionRange?: (start: number, end: number) => void } | null }} [options]
 * @returns {() => void} detach
 */
export function attachMobilePaste(rfb, options = {}) {
  const button = options.button;
  if (!button || rfb.viewOnly) return () => {};
  button.hidden = false;
  const onClick = async () => {
    const clipboard = options.clipboard ?? globalThis.navigator?.clipboard;
    const fallback = options.fallbackFocus;
    // Focus during the tap, before any await, so a denial still has a software
    // keyboard and a caret parked after the sentinel.
    focusPasteTarget(fallback);
    const text = await readHostClipboardText(clipboard);
    if (text) {
      pasteHostText(rfb, text);
      fallback?.blur?.();
      return;
    }
    if (text === "") fallback?.blur?.();
  };
  button.addEventListener("click", onClick);
  return () => {
    button.removeEventListener("click", onClick);
  };
}

/**
 * Sandbox → host copy: Debian noVNC 1.3 dispatches a "clipboard" CustomEvent
 * with detail.text when x11vnc reports a remote CLIPBOARD change
 * (ServerCutText). navigator.clipboard.writeText needs a secure context and
 * can be denied without a gesture, so failures are silent.
 * @param {{ addEventListener?: (type: string, listener: (event: object) => void) => void, removeEventListener?: (type: string, listener: (event: object) => void) => void } | null | undefined} rfb
 * @param {{ clipboard?: { writeText?: (text: string) => Promise<void> } | null }} [options]
 * @returns {() => void} detach
 */
export function attachRemoteClipboardCopy(rfb, options = {}) {
  const clipboard = options.clipboard ?? globalThis.navigator?.clipboard;
  if (typeof rfb?.addEventListener !== "function") return () => {};
  if (!clipboard || typeof clipboard.writeText !== "function") return () => {};
  const onClipboard = async (event) => {
    const text = event?.detail?.text;
    if (typeof text !== "string") return;
    try {
      await clipboard.writeText(text);
    } catch {
      // Clipboard writes can be denied without a gesture; stay silent.
    }
  };
  rfb.addEventListener("clipboard", onClipboard);
  return () => {
    rfb.removeEventListener?.("clipboard", onClipboard);
  };
}

/**
 * @param {{ viewOnly?: boolean, clipboardPasteFrom?: (text: string) => void, sendKey?: Function, _rfbConnectionState?: string }} rfb
 * @param {{ target?: EventTarget }} [options]
 * @returns {() => void} detach
 */
export function attachHostClipboardPaste(rfb, options = {}) {
  const target = options.target ?? globalThis;
  const onKeyDown = (event) => {
    if (rfb.viewOnly || !isPasteChord(event)) return;
    // Keep default so the browser still fires `paste` with clipboardData.
    event.stopPropagation();
  };
  const onKeyUp = (event) => {
    if (rfb.viewOnly || !isPasteChord(event)) return;
    event.stopPropagation();
  };
  const onPaste = (event) => {
    if (rfb.viewOnly) return;
    const text = clipboardTextFromPaste(event);
    if (!text) return;
    if (!pasteHostText(rfb, text)) return;
    event.preventDefault();
    event.stopPropagation();
  };

  target.addEventListener("keydown", onKeyDown, true);
  target.addEventListener("keyup", onKeyUp, true);
  target.addEventListener("paste", onPaste, true);
  return () => {
    target.removeEventListener("keydown", onKeyDown, true);
    target.removeEventListener("keyup", onKeyUp, true);
    target.removeEventListener("paste", onPaste, true);
  };
}
