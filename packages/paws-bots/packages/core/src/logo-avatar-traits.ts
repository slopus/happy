import { BOT_COLORS } from "@rakazo/contracts";
import { resolvePersonaColorDef, shippedHash, shippedRandom } from "./bot-avatar-colors.js";

/** Every supported track completes whole cycles in this exact export interval. */
export const LOGO_AVATAR_LOOP_MS = 24_000;
const SLOW_PERIODS = [4000, 4800, 6000] as const;

/** A saved bot id supplies the colour seed; this stream never advances its motion clocks. */
export function seededLogoAvatarColor(identity: string): string {
  const random = shippedRandom(shippedHash(`logo-avatar/color/v1/${identity}`));
  return BOT_COLORS[Math.floor(random() * BOT_COLORS.length)]!;
}

/** Evaluate once per identity, never on an animation frame or from React's useId. */
export function logoAvatarTraits(identity: string, color?: string) {
  const random = shippedRandom(shippedHash(`logo-avatar/v2/${identity}`));
  const blinkVariant = random() < 0.5 ? "three" : "four";
  const blinkMs = LOGO_AVATAR_LOOP_MS;
  const blinkDelayMs = -Math.round(random() * blinkMs * 1000) / 1000;
  const tempo = Math.floor(random() * 3);
  const phase = random();
  const side = random() > 0.5 ? 1 : -1;
  const energy = 0.92 + random() * 0.16;
  const colorDef = resolvePersonaColorDef(identity, color || seededLogoAvatarColor(identity));
  return {
    color: colorDef.hex,
    originalOrange: colorDef.id === "orange",
    blinkMs,
    blinkVariant,
    blinkDelayMs,
    phase,
    side,
    energy,
    periods: {
      idle: LOGO_AVATAR_LOOP_MS,
      working: SLOW_PERIODS[tempo]!,
      reading: SLOW_PERIODS[tempo]!,
      writing: [1200, 1500, 2000][tempo]!,
      thinking: 6000,
      computer: 6000,
      waiting: SLOW_PERIODS[tempo]!,
      error: SLOW_PERIODS[tempo]!,
    },
  } as const;
}
