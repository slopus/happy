import { randomInt } from "node:crypto";
import type { BotAvatarSet } from "@rakazo/contracts";
import { BOT_COLORS, parseBotAvatarValue } from "@rakazo/contracts";
import {
  ORGANIC_AVATAR_HEART_FAMILY,
  ORGANIC_AVATAR_LOOKS,
  organicAvatarFamily,
  organicAvatarLook,
  resolvePersonaColorDef,
  seededLogoAvatarColor,
} from "@rakazo/core";

/** A uniform number in [0, 1). */
export type Random = () => number;

const RANDOM_RANGE = 2 ** 32;
const cryptoRandom: Random = () => randomInt(RANDOM_RANGE) / RANDOM_RANGE;

/** Tries before settling for a non-heart id; each try matches the wanted family about 1 in 10. */
export const BOT_ID_ATTEMPTS = 200;

/** One of the options the existing values use least, at random among ties, preferring any not in `avoid`. */
export function pickLeastUsed<T>(
  options: readonly T[],
  used: readonly T[],
  random: Random,
  avoid: readonly T[] = [],
): T {
  const counts = options.map((option) => used.filter((value) => value === option).length);
  const fewest = Math.min(...counts);
  const least = options.filter((_, index) => counts[index] === fewest);
  const preferred = least.filter((option) => !avoid.includes(option));
  const candidates = preferred.length > 0 ? preferred : least;
  return candidates[Math.floor(random() * candidates.length)] ?? options[0]!;
}

/** Cuid-shaped: "c", eight base-36 time digits, then sixteen random base-36 digits. */
function cuidShapedId(random: Random, now: number): string {
  let suffix = "";
  for (let index = 0; index < 16; index++) suffix += Math.floor(random() * 36).toString(36);
  return `c${now.toString(36).padStart(8, "0").slice(-8)}${suffix}`;
}

/** An id on the look the user's bots use least, never a heart. */
function balancedId(usedLooks: readonly number[], random: Random, now: number): string {
  const look = pickLeastUsed(ORGANIC_AVATAR_LOOKS, usedLooks, random);
  const isHeart = (botId: string) => organicAvatarFamily(botId) === ORGANIC_AVATAR_HEART_FAMILY;
  let id = cuidShapedId(random, now);
  let lastNonHeart = isHeart(id) ? undefined : id;
  for (
    let attempt = 1;
    attempt < BOT_ID_ATTEMPTS && organicAvatarLook(organicAvatarFamily(id)) !== look;
    attempt++
  ) {
    id = cuidShapedId(random, now);
    if (!isHeart(id)) lastNonHeart = id;
  }
  // The cap may relax balancing, but must never relax the heart exclusion.
  if (isHeart(id) && lastNonHeart) id = lastNonHeart;
  while (isHeart(id)) id = cuidShapedId(random, now);
  return id;
}

/** An id drawn with exactly the requested organic family; each try lands about 1 in 10. */
function idForFamily(family: number, random: Random, now: number): string {
  let id = cuidShapedId(random, now);
  while (organicAvatarFamily(id) !== family) id = cuidShapedId(random, now);
  return id;
}

/**
 * Picks the id and colour of a new bot so it looks unlike the user's other bots.
 *
 * Every client draws a bot's organic body from a hash of its id (`organicAvatarFamily`), and
 * no shape is stored. Choosing the id is therefore how the choice reaches every device the
 * same way, app builds already installed included, without a new column or avatar value.
 * Existing bots keep their ids, so their look never changes.
 *
 * Shapes are balanced by look, where two near-identical families count as one, and a tie
 * between colours goes to one no bot with the same look wears. Bots with a picture or an
 * Avatar Studio shape do not draw an organic body and are not counted for the look. A colour
 * passed by the caller is kept, and so is an organic family the caller picked (the create
 * dialog previews one before the bot has an id). A reserved preview id takes precedence
 * over automatic family selection.
 */
export function chooseBotAvatar(
  existing: readonly { id: string; color: string }[],
  color: string | undefined,
  {
    random = cryptoRandom,
    now = Date.now(),
    family,
    avatarSet = "organic",
    id: previewId,
  }: { random?: Random; now?: number; family?: number; avatarSet?: BotAvatarSet; id?: string } = {},
): { id: string; color: string } {
  if (avatarSet === "rakazo") {
    // The logo uses no organic family. Keep automatic ids non-heart for a later
    // Original-set switch, without scanning the roster or balancing unused shapes.
    if (previewId) return { id: previewId, color: color ?? seededLogoAvatarColor(previewId) };
    let id = family === undefined ? cuidShapedId(random, now) : idForFamily(family, random, now);
    while (family === undefined && organicAvatarFamily(id) === ORGANIC_AVATAR_HEART_FAMILY)
      id = cuidShapedId(random, now);
    return { id, color: color ?? seededLogoAvatarColor(id) };
  }
  const avatars = existing.map((bot) => {
    const avatar = parseBotAvatarValue(bot.color);
    return {
      look:
        avatar.kind === "color" || avatar.kind === "other"
          ? organicAvatarLook(organicAvatarFamily(bot.id))
          : null,
      // A color saved as its earlier value is shown as, and so counts as, its palette color.
      color:
        avatar.kind === "color" || avatar.kind === "shape"
          ? resolvePersonaColorDef(bot.id, avatar.color).hex.toUpperCase()
          : null,
    };
  });
  const lookOf = (botId: string) => organicAvatarLook(organicAvatarFamily(botId));
  const id =
    previewId ??
    (family === undefined
      ? balancedId(
          avatars.flatMap((avatar) => (avatar.look === null ? [] : [avatar.look])),
          random,
          now,
        )
      : idForFamily(family, random, now));
  const colors = (bots: typeof avatars) =>
    bots.flatMap((avatar) => (avatar.color === null ? [] : [avatar.color]));
  return {
    id,
    color:
      color ??
      pickLeastUsed(
        BOT_COLORS,
        colors(avatars),
        random,
        colors(avatars.filter((avatar) => avatar.look === lookOf(id))),
      ),
  };
}
