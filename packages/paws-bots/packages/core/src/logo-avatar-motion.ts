import type { LogoAvatarActivity } from "./logo-avatar-activity.js";
import { logoAvatarNeedsAttention } from "./logo-avatar-activity.js";
import type { logoAvatarTraits } from "./logo-avatar-traits.js";

type Track = readonly (readonly [number, number])[];
export type LogoAvatarTraits = ReturnType<typeof logoAvatarTraits>;
export interface LogoAvatarFrame {
  eyeX: number;
  eyeY: number;
  lid: number;
  blink: number;
  bodyY: number;
  bodyScale: number;
  pageX: number;
  pageY: number;
  keyLeft: number;
  keyRight: number;
  keyLeftY: number;
  keyRightY: number;
  pointerX: number;
  pointerY: number;
  selection: number;
}

/** Immutable authored tracks reused on the UI thread; no per-frame array allocation. */
export const LOGO_AVATAR_MOTION_TRACKS = {
  blink: [
    [0, 1],
    [50 / 160, 0.06],
    [70 / 160, 0.06],
    [1, 1],
  ],
  breathe: [
    [0, 1],
    [0.5, 1.005],
    [1, 1],
  ],
  idleX: [
    [0, 0],
    [0.66, 0],
    [0.7, 4],
    [0.78, 4],
    [0.82, 0],
    [1, 0],
  ],
  idleY: [
    [0, 0],
    [0.66, 0],
    [0.7, -2],
    [0.78, -2],
    [0.82, 0],
    [1, 0],
  ],
  readingX: [
    [0, 0],
    [0.06, 0],
    [0.24, 20],
    [0.28, 20],
    [0.34, 0],
    [0.38, 0],
    [0.54, 20],
    [0.58, 20],
    [0.64, 0],
    [0.68, 0],
    [0.84, 20],
    [0.88, 20],
    [0.96, 0],
    [1, 0],
  ],
  readingY: [
    [0, 0],
    [0.28, 0],
    [0.34, 5],
    [0.58, 5],
    [0.64, 10],
    [0.88, 10],
    [0.96, 0],
    [1, 0],
  ],
  readingLid: [
    [0, 0.76],
    [0.88, 0.76],
    [0.92, 0.06],
    [0.94, 0.06],
    [0.98, 0.76],
    [1, 0.76],
  ],
  pageX: [
    [0, 0],
    [0.06, 0],
    [0.24, 37],
    [0.28, 37],
    [0.34, 0],
    [0.38, 0],
    [0.54, 37],
    [0.58, 37],
    [0.64, 0],
    [0.68, 0],
    [0.84, 37],
    [0.88, 37],
    [0.96, 0],
    [1, 0],
  ],
  pageY: [
    [0, 0],
    [0.28, 0],
    [0.34, 3],
    [0.58, 3],
    [0.64, 6],
    [0.88, 6],
    [0.96, 0],
    [1, 0],
  ],
  writingY: [
    [0, 0],
    [0.1, 0],
    [0.18, 3],
    [0.26, 0],
    [0.56, 0],
    [0.64, 6],
    [0.74, 0],
    [1, 0],
  ],
  bodyY: [
    [0, 0],
    [0.1, 0],
    [0.18, 0.9],
    [0.26, 0],
    [0.56, 0],
    [0.64, 1.4],
    [0.74, 0],
    [1, 0],
  ],
  keyLeft: [
    [0, 0.7],
    [0.1, 0.7],
    [0.18, 1],
    [0.26, 0.7],
    [1, 0.7],
  ],
  keyRight: [
    [0, 0.7],
    [0.56, 0.7],
    [0.64, 1],
    [0.74, 0.7],
    [1, 0.7],
  ],
  keyLeftY: [
    [0, 0],
    [0.1, 0],
    [0.18, 1],
    [0.26, 0],
    [1, 0],
  ],
  keyRightY: [
    [0, 0],
    [0.56, 0],
    [0.64, 1],
    [0.74, 0],
    [1, 0],
  ],
  thinkingX: [
    [0, 0],
    [0.08, 0],
    [0.24, -9],
    [0.4, -9],
    [0.56, -5],
    [0.65, -5],
    [0.82, 0],
    [0.9, 0],
    [1, 0],
  ],
  thinkingY: [
    [0, -2],
    [0.08, -2],
    [0.24, -8],
    [0.4, -8],
    [0.56, -11],
    [0.65, -11],
    [0.82, -3],
    [0.9, -3],
    [1, -2],
  ],
  thinkingLid: [
    [0, 1],
    [0.08, 1],
    [0.24, 0.8],
    [0.4, 0.8],
    [0.56, 0.68],
    [0.65, 0.68],
    [0.82, 0.9],
    [0.9, 0.9],
    [1, 1],
  ],
  computerX: [
    [0, -10],
    [0.08, -10],
    [0.18, 10],
    [0.34, 10],
    [0.48, -8],
    [0.76, -8],
    [0.92, -10],
    [1, -10],
  ],
  computerY: [
    [0, -3],
    [0.34, -3],
    [0.48, 6],
    [0.76, 6],
    [0.92, -3],
    [1, -3],
  ],
  pointerX: [
    [0, 0],
    [0.08, 0],
    [0.18, 18],
    [0.34, 18],
    [0.48, 7],
    [0.76, 7],
    [0.92, 0],
    [1, 0],
  ],
  pointerY: [
    [0, 0],
    [0.34, 0],
    [0.48, 2],
    [0.76, 2],
    [0.92, 0],
    [1, 0],
  ],
  selection: [
    [0, 0],
    [0.5, 0],
    [0.56, 0.85],
    [0.76, 0.85],
    [0.84, 0],
    [1, 0],
  ],
} as const satisfies Record<string, Track>;
const BLINK_STARTS_THREE = [4100, 11500, 20000] as const;
const BLINK_STARTS_FOUR = [3200, 8900, 14200, 21100] as const;

/** Cubic-bezier inversion matches native CSS timing, with no overshoot. */
function ease(value: number, x1 = 0.45, x2 = 0.25): number {
  "worklet";
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  let low = 0;
  let high = 1;
  for (let index = 0; index < 20; index++) {
    const t = (low + high) / 2;
    const x = 3 * (1 - t) ** 2 * t * x1 + 3 * (1 - t) * t ** 2 * x2 + t ** 3;
    if (x < value) low = t;
    else high = t;
  }
  const t = (low + high) / 2;
  return 3 * (1 - t) * t ** 2 + t ** 3;
}

function sample(track: Track, progress: number, blink = false): number {
  "worklet";
  for (let index = 1; index < track.length; index++) {
    const left = track[index - 1]!;
    const right = track[index]!;
    if (progress > right[0]) continue;
    if (left[1] === right[1]) return left[1];
    const amount = (progress - left[0]) / (right[0] - left[0]);
    return left[1] + (right[1] - left[1]) * ease(amount, blink ? 0.42 : 0.45, blink ? 0.58 : 0.25);
  }
  return track[track.length - 1]![1];
}

function phase(elapsed: number, delay: number, period: number): number {
  "worklet";
  return ((((elapsed - delay) % period) + period) % period) / period;
}

/**
 * Stateless UI-thread sampler of the shared100-unit SVG motion. Web CSS mirrors
 * these authored tracks; callers retain elapsed active time across state changes.
 * Blink1 means open and .06 means closed. Reduced motion always leaves eyes open.
 */
export function logoAvatarFrame(
  activity: LogoAvatarActivity,
  traits: LogoAvatarTraits,
  elapsedMs: number,
  reduced = false,
): LogoAvatarFrame {
  "worklet";
  const result: LogoAvatarFrame = {
    eyeX: 0,
    eyeY: 0,
    lid: 1,
    blink: 1,
    bodyY: 0,
    bodyScale: 1,
    pageX: 0,
    pageY: 0,
    keyLeft: 0.7,
    keyRight: 0.7,
    keyLeftY: 0,
    keyRightY: 0,
    pointerX: 0,
    pointerY: 0,
    selection: 0,
  };
  if (activity === "reading") {
    result.eyeX = -10;
    result.eyeY = -5;
    result.lid = 0.76;
  } else if (activity === "writing") {
    result.eyeY = 10;
    result.lid = 0.62;
  } else if (activity === "thinking") {
    result.eyeX = -3 * traits.side;
    result.eyeY = -4;
    result.lid = 0.8;
  } else if (activity === "computer") result.lid = 1.12;
  else if (logoAvatarNeedsAttention(activity)) result.lid = 0.9;
  else if (activity === "error") result.lid = 0.68;
  if (reduced) return result;
  if (!logoAvatarNeedsAttention(activity) && activity !== "error") {
    const time = phase(elapsedMs, traits.blinkDelayMs, traits.blinkMs) * traits.blinkMs;
    const starts = traits.blinkVariant === "three" ? BLINK_STARTS_THREE : BLINK_STARTS_FOUR;
    for (const start of starts) {
      if (time >= start && time <= start + 160) {
        result.blink = sample(LOGO_AVATAR_MOTION_TRACKS.blink, (time - start) / 160, true);
        break;
      }
    }
  }
  const period = traits.periods[activity];
  const delay = -Math.round(period * traits.phase * 1000) / 1000;
  const p = phase(elapsedMs, delay, period);
  if (activity === "idle" || activity === "working") {
    result.bodyScale = sample(LOGO_AVATAR_MOTION_TRACKS.breathe, p);
    if (activity === "idle") {
      result.eyeX = sample(LOGO_AVATAR_MOTION_TRACKS.idleX, p) * traits.side;
      result.eyeY = sample(LOGO_AVATAR_MOTION_TRACKS.idleY, p);
    }
  } else if (activity === "reading") {
    result.eyeX += sample(LOGO_AVATAR_MOTION_TRACKS.readingX, p);
    result.eyeY += sample(LOGO_AVATAR_MOTION_TRACKS.readingY, p);
    result.lid = sample(LOGO_AVATAR_MOTION_TRACKS.readingLid, p);
    result.pageX = sample(LOGO_AVATAR_MOTION_TRACKS.pageX, p);
    result.pageY = sample(LOGO_AVATAR_MOTION_TRACKS.pageY, p);
  } else if (activity === "writing") {
    result.eyeY += sample(LOGO_AVATAR_MOTION_TRACKS.writingY, p);
    result.bodyY = sample(LOGO_AVATAR_MOTION_TRACKS.bodyY, p);
    result.keyLeft = sample(LOGO_AVATAR_MOTION_TRACKS.keyLeft, p);
    result.keyRight = sample(LOGO_AVATAR_MOTION_TRACKS.keyRight, p);
    result.keyLeftY = sample(LOGO_AVATAR_MOTION_TRACKS.keyLeftY, p);
    result.keyRightY = sample(LOGO_AVATAR_MOTION_TRACKS.keyRightY, p);
  } else if (activity === "thinking") {
    result.eyeX += sample(LOGO_AVATAR_MOTION_TRACKS.thinkingX, p) * traits.side;
    result.eyeY += sample(LOGO_AVATAR_MOTION_TRACKS.thinkingY, p);
    result.lid = sample(LOGO_AVATAR_MOTION_TRACKS.thinkingLid, p);
  } else if (activity === "computer") {
    result.eyeX = sample(LOGO_AVATAR_MOTION_TRACKS.computerX, p);
    result.eyeY = sample(LOGO_AVATAR_MOTION_TRACKS.computerY, p);
    result.pointerX = sample(LOGO_AVATAR_MOTION_TRACKS.pointerX, p);
    result.pointerY = sample(LOGO_AVATAR_MOTION_TRACKS.pointerY, p);
    result.selection = sample(LOGO_AVATAR_MOTION_TRACKS.selection, p);
  }
  return result;
}
