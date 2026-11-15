import { describe, expect, it } from "vitest";
import {
  avatarIdentitySeed,
  ORGANIC_AVATAR_FAMILY_COUNT,
  ORGANIC_AVATAR_HEART_FAMILY,
  ORGANIC_AVATAR_LOOKS,
  organicAvatarFamily,
  organicAvatarPath,
  organicAvatarSampleIdentity,
} from "./avatar-shape.js";

describe("organic avatar geometry", () => {
  it("is stable for an identity and changes across identities", () => {
    const first = organicAvatarPath(avatarIdentitySeed("research"));
    expect(first).toBe(organicAvatarPath(avatarIdentitySeed("research")));
    expect(first).not.toBe(organicAvatarPath(avatarIdentitySeed("health")));
  });

  it("emits only path geometry from a numeric seed", () => {
    const path = organicAvatarPath(42);
    expect(path).toMatch(/^M[-0-9. ]+(?:C[-0-9. ]+)+Z$/);
    expect(path).not.toMatch(/<|>|javascript:|url\(/i);
  });

  it("produces ten distinct smooth shape families", () => {
    const families = Array.from({ length: 10 }, (_, seed) =>
      organicAvatarPath(seed, -((seed % 360) * Math.PI) / 180),
    );
    expect(new Set(families)).toHaveLength(10);
    expect(families.every((path) => (path.match(/C/g) ?? []).length >= 12)).toBe(true);
  });

  it("names the family an identity is drawn with", () => {
    // Without its per-identity phase, a body is its family's template.
    const unphased = (seed: number) => organicAvatarPath(seed, -((seed % 360) * Math.PI) / 180);
    for (const identity of ["research", "health", "cmh2x9k0a0000abcd1234efgh", "Chief"]) {
      const family = organicAvatarFamily(identity);
      expect(family).toBeGreaterThanOrEqual(0);
      expect(family).toBeLessThan(ORGANIC_AVATAR_FAMILY_COUNT);
      expect(unphased(avatarIdentitySeed(identity))).toBe(unphased(family));
    }
  });
});

describe("organic avatar looks", () => {
  it("offers every look but the heart once", () => {
    expect([...ORGANIC_AVATAR_LOOKS].sort()).toEqual([0, 1, 2, 3, 4, 5, 7, 9]);
    expect(ORGANIC_AVATAR_LOOKS).not.toContain(ORGANIC_AVATAR_HEART_FAMILY);
  });

  it("finds a stable sample identity for each family", () => {
    for (let family = 0; family < ORGANIC_AVATAR_FAMILY_COUNT; family++) {
      const identity = organicAvatarSampleIdentity(family);
      expect(organicAvatarFamily(identity)).toBe(family);
      expect(organicAvatarSampleIdentity(family)).toBe(identity);
    }
  });
});
