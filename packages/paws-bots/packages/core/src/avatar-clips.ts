/**
 * Authored motion clips for live bot avatars, played flat (2-D) on our shapes: each clip
 * is a few seconds of head motion (rotation as [pitch, yaw, roll] in degrees, position as
 * a fraction of the avatar's radius scaled by zoom, zoom relative to the rest pose, and lid
 * closedness with 1 shut). A key's ease shapes the segment that leaves it, as a cubic
 * Bézier whose value may overshoot. Mobile samples these in Reanimated worklets.
 */

type Ease = readonly [number, number, number, number];
/** A keyframe: its time, its value, and the ease of the move that leaves it. */
export type AvatarKey = readonly [time: number, value: readonly number[], ease: Ease];

export interface AvatarClip {
  duration: number;
  position?: readonly AvatarKey[];
  rotation?: readonly AvatarKey[];
  zoom?: readonly AvatarKey[];
  lids?: readonly AvatarKey[];
  blinks?: readonly number[];
}

export type AvatarClipName = string;

/** Ease in and out: the default. */
const SOFT: Ease = [0.45, 0, 0.55, 1];
/** A quicker move that lands softly, like a glance. */
const DART: Ease = [0.35, 0.1, 0.25, 1];
/** A return home that settles with the slightest overshoot. */
const HOME: Ease = [0.4, 0, 0.3, 1.06];
const key = (time: number, value: readonly number[], ease: Ease = SOFT): AvatarKey => [
  time,
  value,
  ease,
];

/**
 * The clips, by name. Working clips look somewhere new about every second, with short,
 * drifting holds, and start and end facing front; resting clips hold still and only blink.
 */
export const AVATAR_CLIPS: Record<AvatarClipName, AvatarClip> = {
  /** Tilts well over one way looking up, then the other way looking down. */
  tilt: {
    duration: 3,
    rotation: [
      key(0, [0, 0, 0]),
      key(0.5, [-14, 20, 16]),
      key(0.75, [-12, 17, 15]),
      key(1.3, [12, -22, -15]),
      key(1.55, [10, -19, -14]),
      key(2.1, [-6, 10, 9]),
      key(2.3, [-5, 8, 8], HOME),
      key(3, [0, 0, 0]),
    ],
    position: [
      key(0, [0, 0]),
      key(0.5, [0.06, 0]),
      key(0.75, [0.055, 0]),
      key(1.3, [-0.06, 0]),
      key(1.55, [-0.055, 0]),
      key(2.1, [0.03, 0]),
      key(2.3, [0.025, 0], HOME),
      key(3, [0, 0]),
    ],
    blinks: [1],
  },
  /** Looks far left, far right, then up and aside, as if scanning the room. */
  scan: {
    duration: 3.1,
    rotation: [
      key(0, [0, 0, 0]),
      key(0.45, [5, -38, -7]),
      key(0.7, [6, -34, -6]),
      key(1.3, [5, 38, 7]),
      key(1.55, [6, 34, 6]),
      key(2.15, [-20, -22, -9]),
      key(2.4, [-18, -19, -8], HOME),
      key(3.1, [0, 0, 0]),
    ],
    position: [
      key(0, [0, 0]),
      key(0.45, [-0.06, 0]),
      key(0.7, [-0.055, 0]),
      key(1.3, [0.06, 0]),
      key(1.55, [0.055, 0]),
      key(2.15, [-0.03, -0.02]),
      key(2.4, [-0.028, -0.02], HOME),
      key(3.1, [0, 0]),
    ],
    blinks: [0.95],
  },
  /** Leans in, eyes narrowed, and reads along two lines, then sits back. */
  lean: {
    duration: 3.5,
    rotation: [
      key(0, [0, 0, 0]),
      key(0.5, [24, -28, -5]),
      key(0.65, [25, -24, -4]),
      key(1.25, [26, 26, 4]),
      key(1.4, [25, 22, 4]),
      key(1.95, [24, -24, -4]),
      key(2.1, [24, -20, -3]),
      key(2.7, [22, 24, 4], HOME),
      key(3.5, [0, 0, 0]),
    ],
    position: [key(0, [0, 0]), key(0.5, [0, 0.08]), key(2.7, [0, 0.08], HOME), key(3.5, [0, 0])],
    zoom: [key(0, [1]), key(0.5, [1.12]), key(2.7, [1.12], HOME), key(3.5, [1])],
    lids: [key(0, [0]), key(0.5, [0.3]), key(2.7, [0.3]), key(3.3, [0])],
    blinks: [1.7],
  },
  /** Glances straight up, then up and aside with a tilt, then briefly down. */
  glance: {
    duration: 2.8,
    rotation: [
      key(0, [0, 0, 0], DART),
      key(0.4, [-30, 0, 0]),
      key(0.65, [-28, 4, -2]),
      key(1.15, [-24, 30, -12]),
      key(1.4, [-22, 27, -11]),
      key(1.95, [10, -16, 7]),
      key(2.15, [9, -14, 6], HOME),
      key(2.8, [0, 0, 0]),
    ],
    position: [
      key(0, [0, 0], DART),
      key(0.4, [0, -0.05]),
      key(0.65, [0, -0.05]),
      key(1.15, [0.04, -0.04]),
      key(1.4, [0.04, -0.04]),
      key(1.95, [-0.03, 0.02]),
      key(2.15, [-0.03, 0.02], HOME),
      key(2.8, [0, 0]),
    ],
    blinks: [1.6],
  },
  /** Bobs three times to a beat, tilting and glancing to alternate sides. */
  bob: {
    duration: 3,
    rotation: [
      key(0, [0, 0, 0]),
      key(0.5, [10, -20, -12]),
      key(1, [0, 0, 0]),
      key(1.5, [10, 20, 12]),
      key(2, [0, 0, 0]),
      key(2.5, [10, -16, -10]),
      key(3, [0, 0, 0]),
    ],
    position: [
      key(0, [0, 0]),
      key(0.5, [-0.05, 0.08]),
      key(1, [0, 0]),
      key(1.5, [0.05, 0.08]),
      key(2, [0, 0]),
      key(2.5, [-0.04, 0.08]),
      key(3, [0, 0]),
    ],
    blinks: [1.2],
  },
  /** Turns far aside and leans closer, narrowing its eyes, as if something caught its eye. */
  peer: {
    duration: 2.8,
    rotation: [
      key(0, [0, 0, 0]),
      key(0.5, [6, 40, 10]),
      key(0.75, [5, 36, 9]),
      key(1.25, [-12, 32, 6]),
      key(1.45, [-11, 30, 6]),
      key(1.95, [8, 38, 10]),
      key(2.15, [7, 35, 9], HOME),
      key(2.8, [0, 0, 0]),
    ],
    position: [key(0, [0, 0]), key(0.5, [0.12, 0]), key(2.15, [0.11, 0], HOME), key(2.8, [0, 0])],
    zoom: [key(0, [1]), key(0.5, [1.08]), key(2.15, [1.08], HOME), key(2.8, [1])],
    lids: [key(0, [0]), key(0.5, [0.2]), key(1.25, [0]), key(1.95, [0.2]), key(2.6, [0])],
    blinks: [1.05],
  },
  /** The rare flourish: a little wind-up, a full turn with a hop, and a happy look up. */
  spin: {
    duration: 2.8,
    rotation: [
      key(0, [0, 0, 0]),
      key(0.35, [-8, 0, -14], [0.4, 0, 0.3, 1]),
      key(1.15, [-14, 0, 368]),
      key(1.45, [-12, 0, 360]),
      key(1.95, [-20, -24, 352]),
      key(2.15, [-18, -21, 353], HOME),
      key(2.8, [0, 0, 360]),
    ],
    position: [key(0, [0, 0]), key(0.35, [0, 0.03]), key(0.75, [0, -0.08]), key(1.15, [0, 0])],
    blinks: [2.3],
  },
  /** Holds still without blinking: a settling face once it is home, or one turned into dots. */
  still: { duration: 5 },
  /** Holds still and blinks once. */
  rest: { duration: 5, blinks: [2.4] },
  /** Holds still a little longer, then blinks. */
  hold: { duration: 6.5, blinks: [3.6] },
  /** Holds still and blinks twice in quick succession. */
  blink: { duration: 5.5, blinks: [2, 2.36] },
};

const NO_CLIP: AvatarClip = { duration: 0 };
/** The clip called `name`, or an empty one. */
export function avatarClip(name: AvatarClipName): AvatarClip {
  "worklet";
  return AVATAR_CLIPS[name] ?? NO_CLIP;
}

/** Which clips each state plays; a pool may repeat a clip to make it likelier. */
export const AVATAR_CLIP_POOLS: Record<
  "working" | "idle" | "compactIdle" | "settling" | "thinking",
  readonly AvatarClipName[]
> = {
  /** Every clip twice and the spin once, so the spin stays a rare flourish. */
  working: [
    ...["tilt", "scan", "lean", "glance", "bob", "peer"].flatMap((clip) => [clip, clip]),
    "spin",
  ],
  /** A live avatar at rest (the call card) only blinks. */
  idle: ["rest", "hold", "blink"],
  /** Small live avatars keep to the gentlest idle clips. */
  compactIdle: ["rest", "hold"],
  /** Every other avatar at rest goes home and holds still, without blinking. */
  settling: ["still"],
  /** The face has turned into the typing dots, so it only needs to hold still. */
  thinking: ["still"],
};

/** The pose a clip moves: angles in degrees, position in radius units, lid closedness. */
export interface AvatarPose {
  pitch: number;
  yaw: number;
  roll: number;
  x: number;
  y: number;
  zoom: number;
  lid: number;
}

/** Facing front, at rest zoom, eyes open: where an empty track sits. */
export const AVATAR_REST_POSE: AvatarPose = {
  pitch: 0,
  yaw: 0,
  roll: 0,
  x: 0,
  y: 0,
  zoom: 1,
  lid: 0,
};

/** How long the bridge between two clips lasts when their poses differ, and its ease. */
export const AVATAR_BRIDGE = { seconds: 0.6, ease: SOFT };

const DEFAULT_EASE: Ease = SOFT;
/** An authored blink: seconds to shut, then seconds to open again. */
const BLINK = { close: 0.08, open: 0.14 };

/** The eased progress (0–1, may overshoot) of a cubic Bézier at time progress `p`. */
export function avatarEase([x1, y1, x2, y2]: Ease, p: number): number {
  "worklet";
  const curve = (a: number, b: number, s: number) =>
    3 * (1 - s) * (1 - s) * s * a + 3 * (1 - s) * s * s * b + s * s * s;
  const slope = (a: number, b: number, s: number) =>
    3 * (1 - s) * (1 - s) * a + 6 * (1 - s) * s * (b - a) + 3 * s * s * (1 - b);
  let s = p;
  for (let step = 0; step < 8; step += 1) {
    const d = slope(x1, x2, s);
    if (Math.abs(d) < 1e-6) break;
    s = Math.min(1, Math.max(0, s - (curve(x1, x2, s) - p) / d));
  }
  return curve(y1, y2, s);
}

/** A track's value at `t`, holding its first and last keys outside them; null when empty. */
export function avatarTrackValue(
  keys: readonly AvatarKey[] | undefined,
  t: number,
): readonly number[] | null {
  "worklet";
  if (!keys || keys.length === 0) return null;
  const first = keys[0]!;
  if (t <= first[0]) return first[1];
  for (let index = 0; index < keys.length - 1; index += 1) {
    const [start, from, ease] = keys[index]!;
    const [end, to] = keys[index + 1]!;
    if (t > end) continue;
    const eased = avatarEase(ease ?? DEFAULT_EASE, (t - start) / Math.max(end - start, 1e-9));
    return from.map((value, axis) => value + ((to[axis] ?? value) - value) * eased);
  }
  return keys[keys.length - 1]![1];
}

/** How shut the eyes are at `t` from a clip's authored blinks (0 open, 1 shut). */
function authoredBlink(blinks: readonly number[] | undefined, t: number): number {
  "worklet";
  let shut = 0;
  const length = BLINK.close + BLINK.open;
  if (length <= 0) return shut;
  for (const start of blinks ?? []) {
    const local = t - start;
    if (local < 0 || local > length) continue;
    const opening = local > BLINK.close;
    const [from, to, span] = opening ? [1, 0, BLINK.open] : [0, 1, BLINK.close];
    const eased = avatarEase(DEFAULT_EASE, (local - (opening ? BLINK.close : 0)) / span);
    shut = Math.max(shut, from + (to - from) * eased);
  }
  return shut;
}

/** A clip's pose at `t` seconds into it. */
export function avatarClipPose(clip: AvatarClip, t: number): AvatarPose {
  "worklet";
  const rotation = avatarTrackValue(clip.rotation, t);
  const position = avatarTrackValue(clip.position, t);
  const zoom = avatarTrackValue(clip.zoom, t);
  const lids = avatarTrackValue(clip.lids, t);
  return {
    pitch: rotation?.[0] ?? 0,
    yaw: rotation?.[1] ?? 0,
    roll: rotation?.[2] ?? 0,
    x: position?.[0] ?? 0,
    y: position?.[1] ?? 0,
    zoom: zoom?.[0] ?? AVATAR_REST_POSE.zoom,
    lid: Math.max(lids?.[0] ?? 0, authoredBlink(clip.blinks, t)),
  };
}
