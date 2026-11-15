/** Host → sandbox paste helpers for the chrome-less noVNC embed. */

export const KEYSYM: {
  Control_L: number;
  Control_R: number;
  Alt_L: number;
  Alt_R: number;
  Super_L: number;
  Super_R: number;
  Mode_switch: number;
  ISO_Level3_Shift: number;
  v: number;
};

export function isPasteChord(event: {
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  code?: string;
  key?: string;
}): boolean;

export function clipboardTextFromPaste(event: {
  clipboardData?: { getData: (type: string) => string } | null;
}): string;

export function isRfbConnected(rfb: { _rfbConnectionState?: string } | null | undefined): boolean;

export function releaseModifierKeys(
  sendKey: (keysym: number, code: string, down?: boolean) => void,
): void;

export function sendRemotePaste(
  sendKey: (keysym: number, code: string, down?: boolean) => void,
): void;

type EventTargetLike = {
  addEventListener: (
    type: string,
    listener: (event: object) => void,
    options?: boolean | { capture?: boolean },
  ) => void;
  removeEventListener: (
    type: string,
    listener: (event: object) => void,
    options?: boolean | { capture?: boolean },
  ) => void;
};

export function pasteHostText(
  rfb: {
    viewOnly?: boolean;
    clipboardPasteFrom?: (text: string) => void;
    sendKey?: (keysym: number, code: string, down?: boolean) => void;
    _rfbConnectionState?: string;
  },
  text: string,
): boolean;

export function readHostClipboardText(
  clipboard?: {
    readText?: () => Promise<string>;
  } | null,
): Promise<string | null>;

type PasteTargetLike = {
  focus?: () => void;
  blur?: () => void;
  value?: string;
  setSelectionRange?: (start: number, end: number) => void;
};

export function attachMobilePaste(
  rfb: {
    viewOnly?: boolean;
    clipboardPasteFrom?: (text: string) => void;
    sendKey?: (keysym: number, code: string, down?: boolean) => void;
    _rfbConnectionState?: string;
  },
  options?: {
    button?: (EventTargetLike & { hidden?: boolean }) | null;
    clipboard?: { readText?: () => Promise<string> };
    fallbackFocus?: PasteTargetLike | null;
  },
): () => void;

export function attachRemoteClipboardCopy(
  rfb: EventTargetLike | null | undefined,
  options?: {
    clipboard?: { writeText?: (text: string) => Promise<void> } | null;
  },
): () => void;

export function attachHostClipboardPaste(
  rfb: {
    viewOnly?: boolean;
    clipboardPasteFrom?: (text: string) => void;
    sendKey?: (keysym: number, code: string, down?: boolean) => void;
    _rfbConnectionState?: string;
  },
  options?: { target?: EventTargetLike },
): () => void;
