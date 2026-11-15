import { describe, expect, it } from "vitest";
import type { LogoAvatarActivity } from "./logo-avatar-activity.js";
import { logoAvatarFrame } from "./logo-avatar-motion.js";
import { logoAvatarTraits } from "./logo-avatar-traits.js";

const activities: LogoAvatarActivity[] = [
  "idle",
  "working",
  "reading",
  "writing",
  "thinking",
  "computer",
  "waiting",
  "error",
];
const traits = logoAvatarTraits("sampler-proof");
const at = (activity: LogoAvatarActivity, fraction: number) => {
  const period = traits.periods[activity];
  const delay = -Math.round(period * traits.phase * 1000) / 1000;
  return logoAvatarFrame(activity, traits, 24000 + delay + period * fraction);
};

describe("native-safe logo motion", () => {
  it("closes every numeric track at the exact24-second export boundary across identities", () => {
    for (let id = 0; id < 40; id++)
      for (const activity of activities) {
        const identity = logoAvatarTraits(`native-${id}`);
        for (const time of [0, 40, 231, 1111, 4187, 7933, 17117, 23999]) {
          const first = logoAvatarFrame(activity, identity, time);
          const next = logoAvatarFrame(activity, identity, time + 24000);
          for (const key of Object.keys(first) as (keyof typeof first)[])
            expect(next[key]).toBeCloseTo(first[key], 8);
        }
      }
  });

  it("keeps own-loop and export velocities continuous", () => {
    for (const activity of activities) {
      const period = traits.periods[activity];
      const delay = -Math.round(period * traits.phase * 1000) / 1000;
      for (const boundary of [2 * period + delay, 24000]) {
        const before = logoAvatarFrame(activity, traits, boundary - 0.05);
        const seam = logoAvatarFrame(activity, traits, boundary);
        const after = logoAvatarFrame(activity, traits, boundary + 0.05);
        for (const key of Object.keys(seam) as (keyof typeof seam)[]) {
          const left = (seam[key] - before[key]) / 0.05;
          const right = (after[key] - seam[key]) / 0.05;
          expect(Math.abs(right - left), `${activity}:${key}`).toBeLessThan(0.004);
        }
      }
    }
  });

  it("reads three lines with left/down returns and a contained marker grid", () => {
    const frames = [0, 0.26, 0.36, 0.56, 0.66, 0.86, 1].map((p) => at("reading", p));
    expect(frames.map((f) => [f.eyeX, f.eyeY])).toEqual([
      [-10, -5],
      [10, -5],
      [-10, 0],
      [10, 0],
      [-10, 5],
      [10, 5],
      [-10, -5],
    ]);
    expect(frames.map((f) => [f.pageX, f.pageY])).toEqual([
      [0, 0],
      [37, 0],
      [0, 3],
      [37, 3],
      [0, 6],
      [37, 6],
      [0, 0],
    ]);
  });

  it("types with vertical accents, alternating keys, and no sideways shake", () => {
    expect(at("writing", 0.18).keyLeft).toBe(1);
    expect(at("writing", 0.64).keyRight).toBe(1);
    expect(at("writing", 0.64).bodyY).toBeCloseTo(1.4);
    for (let i = 0; i <= 100; i++) expect(at("writing", i / 100).eyeX).toBe(0);
  });

  it("reconsiders on the same side with no frozen hold longer than a second", () => {
    expect(traits.periods.thinking).toBe(6000);
    const main = at("thinking", 0.32),
      next = at("thinking", 0.6);
    expect(main.eyeX * traits.side).toBe(-12);
    expect(next.eyeX * traits.side).toBe(-8);
    expect(next.eyeY).toBeLessThan(main.eyeY);
    let held = 0,
      maxHeld = 0,
      previous = at("thinking", 0);
    for (let ms = 10; ms <= 6000; ms += 10) {
      const current = at("thinking", ms / 6000);
      const still = ["eyeX", "eyeY", "lid"].every(
        (key) =>
          Math.abs(current[key as keyof typeof current] - previous[key as keyof typeof current]) <
          0.0001,
      );
      held = still ? held + 10 : 0;
      maxHeld = Math.max(maxHeld, held);
      previous = current;
      expect(current.eyeX * traits.side).toBeLessThanOrEqual(-3);
    }
    expect(maxHeld).toBeLessThanOrEqual(1010);
  });

  it("follows screen regions and holds a selection without pointer overshoot", () => {
    expect(at("computer", 0.25).pointerX).toBe(18);
    expect(at("computer", 0.6).pointerY).toBe(2);
    expect(at("computer", 0.6).selection).toBe(0.85);
    for (let i = 0; i <= 600; i++) {
      const f = at("computer", i / 600);
      expect(f.pointerX).toBeGreaterThanOrEqual(0);
      expect(f.pointerX).toBeLessThanOrEqual(18);
      expect(f.pointerY).toBeGreaterThanOrEqual(0);
      expect(f.pointerY).toBeLessThanOrEqual(2);
    }
  });

  it("leaves open static eyes for reduced motion at any elapsed time", () => {
    for (const activity of activities) {
      const first = logoAvatarFrame(activity, traits, 0, true);
      expect(first.blink).toBe(1);
      expect(first.lid).toBeGreaterThan(0.6);
      expect(logoAvatarFrame(activity, traits, 31987, true)).toEqual(first);
    }
  });
});
