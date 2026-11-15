export const DEFAULT_TEACH_RECORDING_TTL_MS = 10 * 60 * 1000;

export function teachRecordingTtlMs(): number {
  const raw = Number(process.env.TEACH_RECORDING_TTL_MS ?? DEFAULT_TEACH_RECORDING_TTL_MS);
  return Number.isFinite(raw) && raw >= 1_000 ? raw : DEFAULT_TEACH_RECORDING_TTL_MS;
}

const SPECIAL_TEACH_KEYS = new Set([
  "Enter",
  "Tab",
  "Backspace",
  "Escape",
  "Delete",
  "Home",
  "End",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
]);

export function teachCaptureKey(
  key: string,
  modifiers?: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean },
): string | null {
  if (modifiers?.metaKey || modifiers?.ctrlKey || modifiers?.altKey) return null;
  if (key.length === 1) return key;
  return SPECIAL_TEACH_KEYS.has(key) ? key : null;
}

// Browser key names are not X11 keysyms. Anything sent as a `key` input ends up in
// `xdotool key <name>` (or the e2b equivalent), which silently drops names it cannot resolve.
const X11_KEYSYM_BY_DOM_KEY: Record<string, string> = {
  Enter: "Return",
  Backspace: "BackSpace",
  Escape: "Escape",
  Tab: "Tab",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
};

/**
 * Turns a captured browser key into an input the sandbox can actually apply. Printable
 * characters (including spaces and punctuation) have no keysym of their own, so they are
 * typed as text instead of pressed as a key.
 */
export function computerInputForDomKey(
  key: string,
): { kind: "clipboard"; text: string } | { kind: "key"; key: string } {
  if (key.length === 1) return { kind: "clipboard", text: key };
  return { kind: "key", key: X11_KEYSYM_BY_DOM_KEY[key] ?? key };
}

export const DEFAULT_COMPUTER_SCREEN = { width: 1280, height: 800 } as const;

function clamp(value: number, max: number): number {
  return Math.min(Math.max(value, 0), max);
}

/**
 * The embedded viewer scales the remote framebuffer to fit while preserving its aspect ratio
 * and centres it, so the visible screen is letterboxed inside the container. Map through that
 * letterbox instead of stretching across the whole container rect.
 */
export function mapTeachPointer(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  screen: { width: number; height: number },
): { x: number; y: number } {
  const width = rect.width || 1;
  const height = rect.height || 1;
  const scale = Math.min(width / screen.width, height / screen.height) || 1;
  const offsetX = (width - screen.width * scale) / 2;
  const offsetY = (height - screen.height * scale) / 2;
  return {
    x: clamp(Math.round((clientX - rect.left - offsetX) / scale), screen.width - 1),
    y: clamp(Math.round((clientY - rect.top - offsetY) / scale), screen.height - 1),
  };
}
