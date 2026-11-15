export function mobileInputChanges(
  oldValue: string,
  newValue: string,
  selectionStart?: number | null,
): { backspaces: number; text: string };

export function isTouchBrowser(
  navigatorLike?: { maxTouchPoints?: number },
  windowLike?: object,
): boolean;

export function attachMobileTrackpad(
  rfb: {
    viewOnly?: boolean;
    showDotCursor?: boolean;
  },
  options: {
    button: unknown;
    surface: unknown;
    documentTarget?: unknown;
    sensitivity?: number;
  },
): () => void;

export function attachMobileKeyboard(
  rfb: {
    viewOnly?: boolean;
    focusOnClick?: boolean;
    sendKey: (keysym: number, code?: string, down?: boolean) => void;
  },
  options: {
    button: unknown;
    input: unknown;
    keyBar?: unknown;
    Keyboard: unknown;
    backspaceKeysym: number;
    lookupKeysym: (codePoint: number) => number;
    pasteText?: (text: string) => boolean;
    documentTarget?: unknown;
    windowTarget?: unknown;
  },
): () => void;
