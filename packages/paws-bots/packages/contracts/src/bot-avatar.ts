import * as z from "zod";

/** Per-bot set. Missing values belong to the original renderer. */
export const BotAvatarSetSchema = z.enum(["organic", "rakazo"]);
export type BotAvatarSet = z.infer<typeof BotAvatarSetSchema>;
export const DEFAULT_NEW_BOT_AVATAR_SET: BotAvatarSet = "organic";

export function resolveBotAvatarSet(value?: string | null): BotAvatarSet {
  return value === "rakazo" ? "rakazo" : "organic";
}

export interface BotColorDef {
  id: string;
  name: string;
  /** The bot's one color: its avatar, name and bubble all start from it. */
  hex: string;
  /** Deeper value this color was stored as before; existing bots still resolve through it. */
  previousHex?: string;
}

/** The one bot palette: every picker offers it and the server assigns from it. */
export const BOT_COLOR_LIST: readonly BotColorDef[] = [
  { id: "white", name: "Staff White", hex: "#FFFFFF" },
  {
    id: "violet",
    name: "Executive Violet",
    hex: "#A97EFE",
    previousHex: "#8B5CF6",
  },
  {
    id: "green",
    name: "Emerald",
    hex: "#00C972",
    previousHex: "#10B981",
  },
  {
    id: "orange",
    name: "Forge Orange",
    hex: "#FF781C",
    previousHex: "#F97316",
  },
  {
    id: "cyan",
    name: "Cyber Cyan",
    hex: "#1CC3B0",
    previousHex: "#06B6D4",
  },
  {
    id: "blue",
    name: "Cobalt Blue",
    hex: "#2A92FE",
    previousHex: "#3B82F6",
  },
  {
    id: "yellow",
    name: "Amber Gold",
    hex: "#FFAF38",
    previousHex: "#EAB308",
  },
  {
    id: "brown",
    name: "Caramel Bronze",
    hex: "#A27952",
    previousHex: "#8D6E63",
  },
  {
    id: "red",
    name: "Crimson Red",
    hex: "#FF3E51",
    previousHex: "#EF4444",
  },
  {
    id: "magenta",
    name: "Neon Pink",
    hex: "#FF5EB1",
    previousHex: "#EC4899",
  },
  {
    id: "gray",
    name: "Slate Silver",
    hex: "#94A3B8",
    previousHex: "#64748B",
  },
];

export const BOT_COLORS: readonly string[] = BOT_COLOR_LIST.map((color) => color.hex);

/** Matches the eight shipped mascot shapes in `@rakazo/core`. */
export const BOT_AVATAR_SHAPE_COUNT = 8;

/**
 * 256x256 webp data URLs from Avatar Studio stay well under this. Cap writes so
 * a pasted raw photo cannot bloat every bot list payload.
 */
export const BOT_AVATAR_VALUE_MAX_LENGTH = 200_000;

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const SHAPE_SUFFIX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})::shape_\d+$/;
const DATA_IMAGE = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

export type ParsedBotAvatar =
  | { kind: "image"; imageUrl: string }
  | { kind: "shape"; color: string; shapeIndex: number }
  | { kind: "color"; color: string }
  | { kind: "other"; raw: string };

export function parseBotAvatarValue(raw: string): ParsedBotAvatar {
  if (raw.startsWith("data:image/")) {
    return { kind: "image", imageUrl: raw };
  }
  if (raw.includes("::shape_")) {
    const parts = raw.split("::shape_");
    const color = parts[0] || "#F97316";
    const rawShape = parts[1] ?? "0";
    const parsedShape = /^\d+$/.test(rawShape) ? Number(rawShape) : 0;
    const shapeIndex = Number.isSafeInteger(parsedShape) ? parsedShape % BOT_AVATAR_SHAPE_COUNT : 0;
    return { kind: "shape", color, shapeIndex };
  }
  if (HEX_COLOR.test(raw)) return { kind: "color", color: raw };
  return { kind: "other", raw };
}

/** True for values we persist on `bots.color` (hex, encoded shape, or data image). */
export function isBotAvatarValue(raw: string): boolean {
  if (!raw || raw.length > BOT_AVATAR_VALUE_MAX_LENGTH) return false;
  return HEX_COLOR.test(raw) || SHAPE_SUFFIX.test(raw) || DATA_IMAGE.test(raw);
}

export const BotAvatarValueSchema = z
  .string()
  .min(1)
  .max(BOT_AVATAR_VALUE_MAX_LENGTH)
  .refine(isBotAvatarValue, { message: "Invalid bot avatar" });
