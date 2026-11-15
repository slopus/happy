import { BOT_COLOR_LIST, BOT_COLORS } from "@rakazo/contracts";
import {
  ORGANIC_AVATAR_FAMILY_COUNT,
  ORGANIC_AVATAR_HEART_FAMILY,
  organicAvatarFamily,
  organicAvatarLook,
  seededLogoAvatarColor,
} from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { BOT_ID_ATTEMPTS, chooseBotAvatar, pickLeastUsed } from "./bot-avatar-choice.js";

/** A repeatable stand-in for Math.random. */
function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** Existing bot ids, one per requested organic family. */
function idsForFamilies(families: number[]) {
  return families.map((family) => {
    for (let index = 0; ; index++) {
      const id = `existing-${family}-${index}`;
      if (organicAvatarFamily(id) === family) return id;
    }
  });
}

describe("pickLeastUsed", () => {
  it("only picks among the least-used options, and reaches each of them", () => {
    const random = seeded(1);
    const picks = new Set(
      Array.from({ length: 200 }, () =>
        pickLeastUsed(["a", "b", "c", "d"], ["a", "b", "b"], random),
      ),
    );
    expect(picks).toEqual(new Set(["c", "d"]));
  });
});

describe("chooseBotAvatar", () => {
  it("derives a Rakazo colour from the chosen persistent id, independently of roster order", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const chosen = chooseBotAvatar([], undefined, {
        avatarSet: "rakazo",
        random: seeded(seed),
        now: 0,
      });
      expect(chosen.color).toBe(seededLogoAvatarColor(chosen.id));
      expect(
        chooseBotAvatar([], undefined, { avatarSet: "rakazo", random: seeded(seed), now: 0 }),
      ).toEqual(chosen);
    }
  });

  it("uses the supplied preview identity for both the final id and generated colour", () => {
    const id = "c0123456789abcdef01234567";
    expect(chooseBotAvatar([], undefined, { avatarSet: "rakazo", id })).toEqual({
      id,
      color: seededLogoAvatarColor(id),
    });
    expect(chooseBotAvatar([], "#123456", { avatarSet: "rakazo", id })).toEqual({
      id,
      color: "#123456",
    });
  });

  it("keeps an explicit identity ahead of an automatic organic family choice", () => {
    const id = "c0123456789abcdef01234567";
    expect(chooseBotAvatar([], "#123456", { id, avatarSet: "organic", family: 9 })).toEqual({
      id,
      color: "#123456",
    });
  });

  it.each(["#123456", "#abc", "#8B5CF6::shape_3", "data:image/png;base64,aGVsbG8="])(
    "keeps explicit Rakazo appearance %s",
    (color) => {
      expect(
        chooseBotAvatar([], color, { avatarSet: "rakazo", random: seeded(1), now: 0 }).color,
      ).toBe(color);
    },
  );

  it("gives a new bot the organic family and colour the user's bots use least", () => {
    const existing = idsForFamilies([0, 1, 2, 3, 4, 5, 6, 7, 8]).map((id, index) => ({
      id,
      color: BOT_COLORS[index % 6]!,
    }));
    for (let seed = 1; seed <= 20; seed++) {
      const chosen = chooseBotAvatar(existing, undefined, { random: seeded(seed), now: 0 });
      expect(organicAvatarFamily(chosen.id)).toBe(9);
      expect(BOT_COLORS.slice(6)).toContain(chosen.color);
      expect(chosen.id).toMatch(/^c[a-z0-9]{24}$/);
    }
  });

  it("counts a colour saved as its earlier value as the palette colour it shows", () => {
    const blue = BOT_COLOR_LIST.find((color) => color.id === "blue")!;
    const families = idsForFamilies([0, 1, 3, 4, 5, 7, 9, 0, 1, 3, 4, 5]);
    // Every colour but blue is used once; blue is used once through its earlier value.
    const existing = BOT_COLOR_LIST.map((color, index) => ({
      id: families[index]!,
      color: color.id === "blue" ? blue.previousHex! : color.hex,
    }));
    existing.push({ id: families[11]!, color: blue.hex });
    for (let seed = 1; seed <= 20; seed++) {
      const chosen = chooseBotAvatar(existing, undefined, { random: seeded(seed), now: 0 });
      expect(chosen.color).not.toBe(blue.hex);
    }
  });

  it("treats the two round families as one look", () => {
    // Family 8 is the only unused family, but it is the same round look as family 2.
    const existing = idsForFamilies([0, 1, 2, 3, 4, 5, 6, 7, 9]).map((id) => ({
      id,
      color: "#3EC5A8",
    }));
    const random = seeded(1);
    const looks = Array.from({ length: 20 }, () =>
      organicAvatarLook(organicAvatarFamily(chooseBotAvatar(existing, undefined, { random }).id)),
    );
    // Every look is used once, so the new bot is not pushed into a second round body.
    expect(looks.some((look) => look !== 2)).toBe(true);
  });

  it("breaks a colour tie away from colours already on the same look", () => {
    // The round look is least used; two colours tie as least used, and the first is already on
    // a round bot.
    const [onRound, elsewhere, ...spread] = BOT_COLORS;
    const [round] = idsForFamilies([2]);
    const nonRound = [0, 1, 3, 4, 5, 6, 7, 9];
    const others = idsForFamilies(
      Array.from(
        { length: 1 + spread.length * 2 },
        (_, index) => nonRound[index % nonRound.length]!,
      ),
    );
    const existing = [
      { id: round!, color: onRound! },
      { id: others[0]!, color: elsewhere! },
      ...others.slice(1).map((id, index) => ({ id, color: spread[index % spread.length]! })),
    ];
    for (let seed = 1; seed <= 20; seed++) {
      const chosen = chooseBotAvatar(existing, undefined, { random: seeded(seed), now: 0 });
      expect(organicAvatarLook(organicAvatarFamily(chosen.id))).toBe(2);
      expect(chosen.color).toBe(elsewhere);
    }
  });

  it("does not count bots that show a picture or an Avatar Studio shape", () => {
    const [common, shapedColor] = BOT_COLORS;
    const [shaped, pictured] = idsForFamilies([0, 0]);
    const others = idsForFamilies([1, 2, 3, 4, 5, 6, 7, 8, 9]).map((id) => ({
      id,
      color: common!,
    }));
    const chosen = chooseBotAvatar(
      [
        ...others,
        { id: shaped!, color: `${shapedColor}::shape_2` },
        { id: pictured!, color: "data:image/png;base64,AAAA" },
      ],
      undefined,
      { random: seeded(3), now: 0 },
    );
    expect(organicAvatarFamily(chosen.id)).toBe(0);
    // The shaped bot's colour still counts; the picture has none.
    expect(chosen.color).not.toBe(common);
    expect(chosen.color).not.toBe(shapedColor);
  });

  it("draws the organic family the caller picked, even one the user's bots already use", () => {
    const existing = idsForFamilies([3, 3, 3]).map((id) => ({ id, color: "#3EC5A8" }));
    for (let family = 0; family < ORGANIC_AVATAR_FAMILY_COUNT; family++) {
      for (let seed = 1; seed <= 5; seed++) {
        const chosen = chooseBotAvatar(existing, "#8B5CF6", { random: seeded(seed), family });
        expect(organicAvatarFamily(chosen.id)).toBe(family);
        expect(chosen.id).toMatch(/^c[a-z0-9]{24}$/);
        expect(chosen.color).toBe("#8B5CF6");
      }
    }
    expect(organicAvatarFamily(chooseBotAvatar(existing, undefined, { family: 3 }).id)).toBe(3);
  });

  it("keeps a colour the caller chose", () => {
    expect(chooseBotAvatar([], "#123456", { random: seeded(4), now: 0 }).color).toBe("#123456");
  });

  it("never assigns a heart with crypto randomness, regardless of existing looks", () => {
    const ids = idsForFamilies(
      Array.from({ length: ORGANIC_AVATAR_FAMILY_COUNT }, (_, family) => family),
    );
    const balanced = ids
      .filter((id) => organicAvatarFamily(id) !== 8)
      .map((id, index) => ({
        id,
        color: BOT_COLORS[index % BOT_COLORS.length]!,
      }));
    const hearts = Array.from({ length: 12 }, (_, index) => ({
      id: ids[ORGANIC_AVATAR_HEART_FAMILY]!,
      color: BOT_COLORS[index % BOT_COLORS.length]!,
    }));
    const assorted = ids.map((id, index) => ({
      id,
      color:
        index % 3 === 0
          ? "#3EC5A8::shape_2"
          : index % 3 === 1
            ? "data:image/png;base64,AAAA"
            : "#3EC5A8",
    }));
    for (const existing of [[], balanced, hearts, assorted, [...balanced, ...hearts]]) {
      for (let run = 0; run < 400; run++) {
        const chosen = chooseBotAvatar(existing, undefined);
        expect(organicAvatarFamily(chosen.id)).not.toBe(ORGANIC_AVATAR_HEART_FAMILY);
      }
    }
  });

  /** A random stream encoding the requested cuid suffix for each attempt. */
  function idStream(ids: string[]) {
    let calls = 0;
    return () => {
      const call = calls++;
      if (call === 0) return 0; // Choose look 0.
      const digit = call - 1;
      const id = ids[Math.min(Math.floor(digit / 16), ids.length - 1)]!;
      return Number.parseInt(id[9 + (digit % 16)]!, 36) / 36;
    };
  }

  function cuidForFamily(family: number) {
    for (let index = 0; ; index++) {
      const id = `c00000000${index.toString(36).padStart(16, "0")}`;
      if (organicAvatarFamily(id) === family) return id;
    }
  }

  it("rerolls past the cap when every capped candidate is a heart", () => {
    const heart = cuidForFamily(ORGANIC_AVATAR_HEART_FAMILY);
    const safe = cuidForFamily(1);
    const candidates = [...Array<string>(BOT_ID_ATTEMPTS).fill(heart), safe];
    const chosen = chooseBotAvatar([], "#123456", { random: idStream(candidates), now: 0 });
    expect(chosen.id).toBe(safe);
    expect(organicAvatarFamily(chosen.id)).not.toBe(ORGANIC_AVATAR_HEART_FAMILY);
  });

  it("keeps the last non-heart candidate and breaks colour ties using its actual look", () => {
    const safe = cuidForFamily(1);
    const heart = cuidForFamily(ORGANIC_AVATAR_HEART_FAMILY);
    const existing: { id: string; color: string }[] = [{ id: safe, color: BOT_COLORS[0]! }];
    // All colours are equally used, but only the first is on the fallback look.
    for (const color of BOT_COLORS.slice(1)) {
      existing.push({ id: cuidForFamily(3), color });
    }
    const random = idStream([safe, ...Array<string>(BOT_ID_ATTEMPTS - 1).fill(heart)]);
    const chosen = chooseBotAvatar(existing, undefined, { random, now: 0 });
    expect(chosen.id).toBe(safe);
    expect(chosen.color).not.toBe(BOT_COLORS[0]);
  });

  it("settles for the last id after the attempt cap", () => {
    let calls = 0;
    // Always the same digits, so every try draws the same id.
    const random = () => {
      calls += 1;
      return 0;
    };
    const stuck = chooseBotAvatar([], undefined, { random, now: 0 });
    const family = organicAvatarFamily(stuck.id);
    // Family 0 is the only least-used pick a zero random can make; force a miss by using it up.
    const existing = idsForFamilies([family]).map((id) => ({ id, color: "#3EC5A8" }));
    calls = 0;
    const capped = chooseBotAvatar(existing, undefined, { random, now: 0 });
    expect(capped.id).toBe(stuck.id);
    expect(organicAvatarFamily(capped.id)).toBe(family);
    // One family pick, sixteen digits per try, one colour pick.
    expect(calls).toBe(1 + 16 * BOT_ID_ATTEMPTS + 1);
  });
});
