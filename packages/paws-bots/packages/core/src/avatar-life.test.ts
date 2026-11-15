import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AvatarPose } from "./avatar-clips.js";
import {
  AVATAR_BRIDGE,
  AVATAR_CLIP_POOLS,
  AVATAR_CLIPS,
  AVATAR_REST_POSE,
  avatarClip,
  avatarClipPose,
  avatarEase,
  avatarTrackValue,
} from "./avatar-clips.js";
import type { AvatarLifeState } from "./avatar-life.js";
import {
  AVATAR_COMPACT_SIZE,
  AVATAR_EYE_REACH,
  AVATAR_MOTION_UNITS,
  AVATAR_POKE_SECONDS,
  AVATAR_POKES,
  AVATAR_SETTLE_MS,
  AVATAR_STILL_MAX_SIZE,
  AVATAR_TYPING_DOTS,
  avatarClipPool,
  avatarClock,
  avatarFrame,
  avatarLifeState,
  avatarPhotoDot,
  avatarPokeFrame,
  avatarRestingBlink,
  avatarSchedule,
  avatarSchedulePose,
  avatarThinkingDot,
  avatarWorkingDot,
} from "./avatar-life.js";

const row = {
  mode: "lazy" as const,
  onScreen: true,
  hasEyes: true,
  size: 62,
  state: "idle" as AvatarLifeState,
  settling: false,
  reducedMotion: false,
};
/** A repeatable stand-in for Math.random. */
function seeded(seed: number) {
  let value = seed;
  return () => {
    value = (value * 16807) % 2147483647;
    return value / 2147483647;
  };
}

describe("avatar state", () => {
  it("shows a busy bot as working, as thinking while it writes, and resting while it waits on you", () => {
    expect(avatarLifeState("running")).toBe("working");
    expect(avatarLifeState("queued")).toBe("working");
    expect(avatarLifeState("running", true)).toBe("thinking");
    expect(avatarLifeState("waiting_input")).toBe("idle");
    expect(avatarLifeState("waiting_takeover", true)).toBe("idle");
    for (const status of ["idle", "completed", "failed", "cancelled", undefined])
      expect(avatarLifeState(status, true)).toBe("idle");
  });

  it("keeps resting inbox avatars still and plays busy or settling ones", () => {
    expect(avatarClock(row)).toBe("still");
    expect(avatarClock({ ...row, state: "working" })).toBe("running");
    expect(avatarClock({ ...row, state: "thinking" })).toBe("running");
    expect(avatarClock({ ...row, settling: true })).toBe("running");
  });

  it("lets only the call card blink at rest, and the activity mark always moves", () => {
    expect(avatarClock({ ...row, mode: "live" })).toBe("parked");
    expect(avatarClock({ ...row, mode: "running" })).toBe("running");
  });

  it("keeps static, hidden, eyeless and tiny avatars still, even while busy", () => {
    const busy = { ...row, state: "working" as const };
    expect(avatarClock({ ...busy, mode: "static" })).toBe("still");
    expect(avatarClock({ ...busy, onScreen: false })).toBe("still");
    expect(avatarClock({ ...busy, hasEyes: false })).toBe("still");
    expect(avatarClock({ ...busy, size: AVATAR_STILL_MAX_SIZE })).toBe("still");
  });

  it("only blinks a moving avatar under Reduce Motion", () => {
    expect(avatarClock({ ...row, state: "working", reducedMotion: true })).toBe("parked");
    expect(avatarClock({ ...row, reducedMotion: true })).toBe("still");
  });

  it("plays the working pool while busy, the thinking pool while writing, and small avatars the compact pool", () => {
    expect(avatarClipPool("working", 62, "lazy")).toBe(AVATAR_CLIP_POOLS.working);
    expect(avatarClipPool("thinking", 62, "running")).toBe(AVATAR_CLIP_POOLS.thinking);
    expect(avatarClipPool("idle", AVATAR_COMPACT_SIZE - 1, "live")).toBe(
      AVATAR_CLIP_POOLS.compactIdle,
    );
    expect(avatarClipPool("idle", AVATAR_COMPACT_SIZE, "live")).toBe(AVATAR_CLIP_POOLS.idle);
  });
});

/** Made-up clips for the timeline tests: one rolls, one nods, one sways. */
const FIXTURES = {
  "fixture-roll": {
    duration: 2,
    rotation: [
      [0, [0, 0, 0], [0, 0, 1, 1]],
      [2, [0, 0, 30], [0, 0, 1, 1]],
    ],
  },
  "fixture-nod": {
    duration: 3,
    rotation: [
      [0, [0, 0, 0], [0, 0, 1, 1]],
      [3, [20, 0, 0], [0, 0, 1, 1]],
    ],
  },
  "fixture-sway": {
    duration: 1.5,
    position: [
      [0, [0, 0], [0, 0, 1, 1]],
      [1.5, [0.3, 0], [0, 0, 1, 1]],
    ],
  },
} as const;
const FIXTURE_POOL = Object.keys(FIXTURES);
beforeAll(() => Object.assign(AVATAR_CLIPS, FIXTURES));
afterAll(() => {
  for (const name of FIXTURE_POOL) delete AVATAR_CLIPS[name];
});

describe("avatar clips", () => {
  it("eases through a curve, overshooting where the curve does", () => {
    expect(avatarEase([0.5, 0, 0.5, 1], 0)).toBeCloseTo(0);
    expect(avatarEase([0.5, 0, 0.5, 1], 0.5)).toBeCloseTo(0.5);
    expect(avatarEase([0.5, 0, 0.5, 1], 1)).toBeCloseTo(1);
    const overshoot = Math.max(
      ...Array.from({ length: 50 }, (_, step) => avatarEase([0.3, 0, 0.3, 1.5], step / 50)),
    );
    expect(overshoot).toBeGreaterThan(1);
  });

  it("holds a track's first and last keys outside them, and the leaving key's ease shapes each segment", () => {
    const keys = [
      [1, [0], [0, 0, 1, 1]],
      [2, [10], [0.5, 0, 0.5, 1]],
    ] as const;
    expect(avatarTrackValue(keys, 0)).toEqual([0]);
    expect(avatarTrackValue(keys, 3)).toEqual([10]);
    // The first key's linear ease shapes 1 → 2.
    expect(avatarTrackValue(keys, 1.25)?.[0]).toBeCloseTo(2.5, 1);
    expect(avatarTrackValue([], 1)).toBeNull();
  });

  it("rests where a clip has no track", () => {
    const pose = avatarClipPose(FIXTURES["fixture-sway"], 1);
    expect(pose.pitch).toBe(0);
    expect(pose.roll).toBe(0);
    expect(pose.zoom).toBe(AVATAR_REST_POSE.zoom);
  });

  it("schedules clips in shuffled rounds, never the same clip twice in a row", () => {
    const segments = avatarSchedule(FIXTURE_POOL, 0, AVATAR_REST_POSE, seeded(7));
    const clips = segments.flatMap((segment) => (segment.clip ? [segment.clip] : []));
    expect(clips).toHaveLength(6 * FIXTURE_POOL.length);
    for (let index = 1; index < clips.length; index += 1)
      expect(clips[index]).not.toBe(clips[index - 1]);
    for (let round = 0; round < 6; round += 1)
      expect(new Set(clips.slice(round * 3, round * 3 + 3)).size).toBe(3);
  });

  it("plays each clip whole, bridging only with the bridge's length", () => {
    const segments = avatarSchedule(FIXTURE_POOL, 10, AVATAR_REST_POSE, seeded(3));
    let time = 10;
    for (const segment of segments) {
      expect(segment.start).toBeCloseTo(time);
      if (segment.clip) expect(segment.duration).toBe(avatarClip(segment.clip).duration);
      else expect(segment.duration).toBe(AVATAR_BRIDGE.seconds);
      time += segment.duration;
    }
  });

  it("plays a clip listed twice more often, still never twice in a row", () => {
    const pool = ["fixture-roll", "fixture-roll", "fixture-nod", "fixture-nod", "fixture-sway"];
    const clips = avatarSchedule(pool, 0, AVATAR_REST_POSE, seeded(4)).flatMap((segment) =>
      segment.clip ? [segment.clip] : [],
    );
    for (let index = 1; index < clips.length; index += 1)
      expect(clips[index]).not.toBe(clips[index - 1]);
    const count = (name: string) => clips.filter((clip) => clip === name).length;
    expect(count("fixture-roll")).toBeGreaterThan(count("fixture-sway"));
  });

  it("rests when there is nothing to play", () => {
    expect(avatarSchedule([], 0, AVATAR_REST_POSE, seeded(1))).toEqual([]);
    expect(avatarSchedulePose([], 3)).toEqual(AVATAR_REST_POSE);
  });
});

describe("flat avatar frames", () => {
  it("moves the eyes for yaw and pitch, turns the body for roll, and narrows a turned head", () => {
    const frame = avatarFrame({ ...AVATAR_REST_POSE, yaw: 90, pitch: 30, roll: 12 }, 1);
    expect(frame.eyeX).toBeCloseTo(AVATAR_EYE_REACH.x);
    expect(frame.eyeY).toBeCloseTo(AVATAR_EYE_REACH.y / 2);
    expect(frame.rotate).toBeCloseTo(12);
    expect(frame.scaleX).toBeLessThan(1);
  });

  it("rests at the still picture while asleep, eyes open", () => {
    const frame = avatarFrame({ ...AVATAR_REST_POSE, yaw: 40, roll: 20, x: 0.2, lid: 0.5 }, 0);
    expect(frame).toMatchObject({
      rotate: 0,
      translateX: 0,
      eyeX: 0,
      scaleX: 1,
      scaleY: 1,
      lid: 1,
    });
  });

  it("closes the eyes with the lid, leaving a thin line", () => {
    const shut = avatarFrame({ ...AVATAR_REST_POSE, lid: 1 }, 1).lid;
    expect(shut).toBeGreaterThan(0);
    expect(shut).toBeLessThan(0.15);
    expect(avatarFrame(AVATAR_REST_POSE, 1).lid).toBe(1);
  });

  it("keeps blinks, typing dots and tap reactions within range", () => {
    for (const seconds of [0, 0.1, 0.5, 2]) {
      const shut = avatarRestingBlink(seconds);
      expect(shut).toBeGreaterThanOrEqual(0);
      expect(shut).toBeLessThanOrEqual(1);
      for (const slot of [0, 1, 2] as const) {
        expect(avatarThinkingDot(slot, seconds, 0).opacity).toBeCloseTo(0);
        const photo = avatarPhotoDot(slot, seconds * 1000, true);
        expect(photo).toBeGreaterThan(0);
        expect(photo).toBeLessThanOrEqual(1);
      }
    }
    for (const poke of AVATAR_POKES)
      expect(avatarPokeFrame(poke, 1)).toEqual({ rotate: 0, translateY: 0, scaleY: 1, eyeY: 0 });
  });

  it("sizes the working dot for the chat header, inbox rows and large tiles", () => {
    expect(avatarWorkingDot(28)).toMatchObject({ diameter: 10, inset: 0.5 });
    expect(avatarWorkingDot(62)).toMatchObject({ diameter: 12, inset: 0 });
    expect(avatarWorkingDot(80)).toMatchObject({ diameter: 15, inset: 3 });
    expect(avatarWorkingDot(96)).toMatchObject({ diameter: 17, inset: 3 });
    expect(avatarWorkingDot(100).ring).toBeCloseTo(4.6);
  });
});

/** A clip's poses every 10 ms, its last pose included. */
function poses(name: string): AvatarPose[] {
  const clip = avatarClip(name);
  const steps = Math.round(clip.duration * 100);
  return Array.from({ length: steps + 1 }, (_, step) => avatarClipPose(clip, step / 100));
}
/** The largest angle change between two poses; whole turns look the same, so they count as none. */
function turn(a: AvatarPose, b: AvatarPose): number {
  const apart = (x: number, y: number) => Math.abs(x - y - 360 * Math.round((x - y) / 360));
  return Math.max(apart(a.pitch, b.pitch), apart(a.yaw, b.yaw), apart(a.roll, b.roll));
}
/** Whether a pose looks like the rest pose, eyelids aside. */
function still(pose: AvatarPose): boolean {
  return turn(pose, AVATAR_REST_POSE) < 1e-9 && pose.x === 0 && pose.y === 0 && pose.zoom === 1;
}

describe("authored motion", () => {
  const { working, idle, compactIdle, settling, thinking } = AVATAR_CLIP_POOLS;
  const authored = [...new Set([...working, ...idle, ...compactIdle, ...settling, ...thinking])];
  const looks = [...new Set(working)].filter((name) => name !== "spin");
  /** At most this many degrees in 10 ms while looking around, and during the spin. */
  const LOOK_STEP = 4;
  const SPIN_STEP = 12;

  it("starts and ends every clip facing front at rest, eyes open", () => {
    for (const name of authored) {
      const clip = avatarClip(name);
      expect(clip.duration, name).toBeGreaterThan(0);
      for (const t of [0, clip.duration]) {
        const pose = avatarClipPose(clip, t);
        expect(still(pose) && pose.lid === 0, `${name} at ${t}`).toBe(true);
      }
    }
  });

  it("looks around boldly but within bounds, a few seconds per clip, never snapping", () => {
    for (const name of looks) {
      const clip = avatarClip(name);
      expect(clip.duration, name).toBeGreaterThanOrEqual(2.5);
      expect(clip.duration, name).toBeLessThanOrEqual(4);
      const all = poses(name);
      all.forEach((pose, step) => {
        expect(Math.abs(pose.pitch), name).toBeLessThanOrEqual(32);
        expect(Math.abs(pose.yaw), name).toBeLessThanOrEqual(42);
        expect(Math.abs(pose.roll), name).toBeLessThanOrEqual(18);
        expect(Math.max(Math.abs(pose.x), Math.abs(pose.y)), name).toBeLessThanOrEqual(0.15);
        expect(Math.abs(pose.zoom - 1), name).toBeLessThanOrEqual(0.15);
        // Narrowed eyes stay open; only blinks shut them.
        expect(avatarTrackValue(clip.lids, step / 100)?.[0] ?? 0, name).toBeLessThanOrEqual(0.35);
        if (step > 0) expect(turn(pose, all[step - 1]!), name).toBeLessThanOrEqual(LOOK_STEP);
      });
    }
    const frames = looks.flatMap((name) => poses(name).map((pose) => avatarFrame(pose, 1)));
    // The eyes travel well toward the face's edge, and tilts lean the whole face.
    expect(Math.max(...frames.map((frame) => Math.abs(frame.eyeX)))).toBeGreaterThan(18);
    expect(Math.max(...frames.map((frame) => Math.abs(frame.eyeY)))).toBeGreaterThan(12);
    expect(Math.max(...frames.map((frame) => Math.abs(frame.rotate)))).toBeGreaterThan(14);
  });

  it("keeps busy: no working clip holds still for more than a third of a second", () => {
    for (const name of looks) {
      const all = poses(name);
      let held = 0;
      let longest = 0;
      for (let step = 1; step < all.length; step += 1) {
        const [before, now] = [all[step - 1]!, all[step]!];
        const moved =
          turn(now, before) > 0.02 ||
          Math.max(Math.abs(now.x - before.x), Math.abs(now.y - before.y)) > 0.0002;
        held = moved ? 0 : held + 1;
        longest = Math.max(longest, held);
      }
      expect(longest / 100, name).toBeLessThanOrEqual(0.34);
    }
  });

  it("spins a full turn only in the spin, the rarest clip, without a jump", () => {
    for (const name of looks) {
      const rolls = poses(name).map((pose) => pose.roll);
      expect(Math.max(...rolls) - Math.min(...rolls), name).toBeLessThan(40);
    }
    const all = poses("spin");
    const rolls = all.map((pose) => pose.roll);
    expect(Math.max(...rolls) - Math.min(...rolls)).toBeGreaterThanOrEqual(360);
    for (let step = 1; step < all.length; step += 1)
      expect(turn(all[step]!, all[step - 1]!)).toBeLessThanOrEqual(SPIN_STEP);
    const count = (name: string) => working.filter((clip) => clip === name).length;
    for (const name of looks) expect(count(name), name).toBeGreaterThan(count("spin"));
  });

  it("blinks inside every working and call card clip, and the resting clips only blink", () => {
    for (const name of [...working, ...idle]) {
      const clip = avatarClip(name);
      expect(clip.blinks?.length, name).toBeGreaterThan(0);
      for (const blink of clip.blinks ?? []) {
        expect(blink, name).toBeGreaterThan(0);
        expect(blink, name).toBeLessThan(clip.duration - 0.25);
      }
      expect(Math.max(...poses(name).map((pose) => pose.lid)), name).toBeCloseTo(1);
    }
    for (const name of idle) expect(poses(name).every(still), name).toBe(true);
  });

  it("keeps every avatar at rest still, without a blink, except the call card", () => {
    for (const mode of ["static", "lazy", "running"] as const)
      for (const size of [28, 62, 96])
        for (const name of avatarClipPool("idle", size, mode)) {
          expect(avatarClip(name).blinks ?? [], name).toEqual([]);
          expect(
            poses(name).every((pose) => still(pose) && pose.lid === 0),
            name,
          ).toBe(true);
        }
    for (const size of [28, 62])
      expect(
        avatarClipPool("idle", size, "live").some((name) => avatarClip(name).blinks?.length),
      ).toBe(true);
  });

  it("offers several distinct working clips, and small avatars a subset of the resting ones", () => {
    expect(new Set(working).size).toBeGreaterThanOrEqual(5);
    expect(new Set(working).size).toBeLessThanOrEqual(7);
    expect(compactIdle.length).toBeGreaterThan(0);
    for (const name of compactIdle) expect(idle).toContain(name);
  });

  it("plays the working clips back to back without a bridge, a repeat or a jump", () => {
    const segments = avatarSchedule(working, 0, AVATAR_REST_POSE, seeded(5));
    expect(segments.every((segment) => segment.clip)).toBe(true);
    for (let index = 1; index < segments.length; index += 1)
      expect(segments[index]!.clip).not.toBe(segments[index - 1]!.clip);
    const end = segments.at(-1)!.start + segments.at(-1)!.duration;
    let previous = avatarSchedulePose(segments, 0);
    for (let step = 1; step <= end * 100; step += 1) {
      const pose = avatarSchedulePose(segments, step / 100);
      expect(turn(pose, previous)).toBeLessThanOrEqual(SPIN_STEP);
      previous = pose;
    }
  });

  it.each([
    ["a look", "scan", 1],
    ["the spin", "spin", 0.8],
  ])(
    "bridges home from mid-way through %s and is at rest before the settle ends",
    (_, name, at) => {
      const from = avatarClipPose(avatarClip(name), at);
      expect(still(from)).toBe(false);
      const segments = avatarSchedule(avatarClipPool("idle", 62, "lazy"), 20, from, seeded(2));
      expect(segments[0]).toMatchObject({ start: 20, duration: AVATAR_BRIDGE.seconds });
      expect(segments[0]!.clip).toBeUndefined();
      expect(turn(avatarSchedulePose(segments, 20), from)).toBeLessThan(1e-9);
      let previous = from;
      for (let step = 1; step <= 100; step += 1) {
        const pose = avatarSchedulePose(segments, 20 + step / 100);
        expect(turn(pose, previous)).toBeLessThanOrEqual(SPIN_STEP);
        previous = pose;
      }
      expect(AVATAR_BRIDGE.seconds * 1000).toBeLessThan(AVATAR_SETTLE_MS);
      expect(still(avatarSchedulePose(segments, 20 + AVATAR_SETTLE_MS / 1000))).toBe(true);
    },
  );

  it("passes the lead from dot to dot, left to right, about a dot apart inside the avatar", () => {
    const { period } = AVATAR_TYPING_DOTS;
    const highest = (slot: 0 | 1 | 2) => {
      let best = 0;
      for (let step = 1; step < 200; step += 1)
        if (
          avatarThinkingDot(slot, (step / 200) * period, 1).y <
          avatarThinkingDot(slot, (best / 200) * period, 1).y
        )
          best = step;
      return best;
    };
    expect(highest(0)).toBeLessThan(highest(1));
    expect(highest(1)).toBeLessThan(highest(2));
    const [left, middle, right] = ([0, 1, 2] as const).map((slot) => avatarThinkingDot(slot, 0, 1));
    expect(middle!.x).toBe(0);
    expect(left!.x).toBeCloseTo(-right!.x);
    expect(right!.x + right!.radius).toBeLessThan(AVATAR_MOTION_UNITS / 2);
    expect(right!.x - middle!.x).toBeGreaterThanOrEqual(4 * AVATAR_TYPING_DOTS.radius);
    // While the left dot leads, it is bigger and in full colour; the others are faint.
    const t = (highest(0) / 200) * period;
    const [leader, ...others] = ([0, 1, 2] as const).map((slot) => avatarThinkingDot(slot, t, 1));
    expect(leader!.opacity).toBeCloseTo(1);
    for (const other of others) {
      expect(other.opacity).toBeLessThan(0.5);
      expect(other.radius).toBeLessThan(leader!.radius);
    }
  });

  it("folds the typing dots back into the middle as the face returns", () => {
    for (const slot of [0, 2] as const) {
      const dot = avatarThinkingDot(slot, 0.4, 0.1);
      expect(dot.x).toBeCloseTo(0);
      expect(dot.opacity).toBeCloseTo(0);
    }
  });

  it("pulses the photo dots slowly while the bot works and quicker while it writes", () => {
    const peaks = (typing: boolean) => {
      let count = 0;
      for (let ms = 10; ms < 6000; ms += 10) {
        const [before, now, after] = [ms - 10, ms, ms + 10].map((t) =>
          avatarPhotoDot(0, t, typing),
        );
        if (now! > before! && now! >= after!) count += 1;
      }
      return count;
    };
    expect(peaks(true)).toBeGreaterThan(peaks(false));
    expect(peaks(false)).toBeGreaterThan(0);
  });

  it("blinks at rest by shutting the eyes, then opening them again", () => {
    const shut = Array.from({ length: 100 }, (_, step) => avatarRestingBlink(step / 200));
    expect(Math.max(...shut)).toBeCloseTo(1, 1);
    expect(shut.at(-1)).toBe(0);
    expect(avatarRestingBlink(-0.1)).toBe(0);
  });

  it("answers taps with a spin, then a bounce, then a nod, each short and ending at rest", () => {
    expect(AVATAR_POKES).toEqual(["spin", "bounce", "nod"]);
    const frames = (poke: (typeof AVATAR_POKES)[number]) =>
      Array.from({ length: 99 }, (_, step) => avatarPokeFrame(poke, (step + 1) / 100));
    for (const poke of AVATAR_POKES) {
      expect(AVATAR_POKE_SECONDS[poke]).toBeLessThanOrEqual(0.9);
      expect(avatarPokeFrame(poke, 0)).toEqual({ rotate: 0, translateY: 0, scaleY: 1, eyeY: 0 });
    }
    const spin = frames("spin").map((frame) => frame.rotate);
    expect(Math.max(...spin) - Math.min(...spin)).toBeGreaterThanOrEqual(360);
    expect(Math.min(...frames("bounce").map((frame) => frame.translateY))).toBeLessThan(-0.12);
    expect(Math.max(...frames("nod").map((frame) => frame.eyeY))).toBeGreaterThan(12);
    expect(frames("nod").every((frame) => frame.rotate === 0)).toBe(true);
  });
});
