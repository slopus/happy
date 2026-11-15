import { BotAvatarValueSchema, parseBotAvatarValue } from "@rakazo/contracts";
import { lightTokens } from "@rakazo/ui-tokens";
import type { AvatarEyes } from "./avatar-shape.js";
import {
  avatarEyeRects,
  avatarIdentitySeed,
  ORGANIC_AVATAR_EYES,
  ORGANIC_AVATAR_VIEWBOX,
  organicAvatarEyeTilt,
  organicAvatarPath,
} from "./avatar-shape.js";
import { botEyeInk, resolvePersonaColorDef } from "./bot-avatar-colors.js";
import {
  SHIPPED_BOT_AVATAR_EYES,
  SHIPPED_BOT_AVATAR_VIEWBOX,
  shippedBotAvatarShapePath,
} from "./bot-avatar-shapes.js";
import {
  LOGO_AVATAR_BODY_Y,
  LOGO_AVATAR_EYES,
  LOGO_AVATAR_VIEWBOX,
  LOGO_BODY_PATH,
  logoAvatarEyeInk,
} from "./logo-avatar-art.js";
import { logoAvatarTraits } from "./logo-avatar-traits.js";

/** A static notification portrait, with the same identity, saved photo and silhouette as chat. */
export function notificationAvatarSource(bot: {
  id: string;
  color: string;
  avatarSet?: string | null;
}): string {
  const parsed = BotAvatarValueSchema.safeParse(bot.color).success
    ? parseBotAvatarValue(bot.color)
    : null;
  if (parsed?.kind === "image") return parsed.imageUrl;
  const color = resolvePersonaColorDef(
    bot.id,
    parsed && "color" in parsed ? parsed.color : bot.color,
  ).hex;
  // The push is flattened onto white, so the eyes are inked for a light page.
  let viewBox: string;
  let body: string;
  if (parsed?.kind === "shape") {
    viewBox = SHIPPED_BOT_AVATAR_VIEWBOX;
    body = `<path d="${shippedBotAvatarShapePath(parsed.shapeIndex)}" fill="${color}"/>${barEyes(SHIPPED_BOT_AVATAR_EYES, botEyeInk(color, lightTokens))}`;
  } else if (bot.avatarSet === "rakazo") {
    const fill = logoAvatarTraits(bot.id, color).color;
    const { width, height, leftCx, rightCx, cy } = LOGO_AVATAR_EYES;
    const eyes = [leftCx, rightCx]
      .map((cx) => `<ellipse cx="${cx}" cy="${cy}" rx="${width / 2}" ry="${height / 2}"/>`)
      .join("");
    viewBox = LOGO_AVATAR_VIEWBOX;
    body = `<g transform="translate(0 ${LOGO_AVATAR_BODY_Y})"><path d="${LOGO_BODY_PATH}" fill="${fill}"/><g fill="${logoAvatarEyeInk(fill, lightTokens)}">${eyes}</g></g>`;
  } else {
    const seed = avatarIdentitySeed(bot.id);
    viewBox = ORGANIC_AVATAR_VIEWBOX;
    body = `<path d="${organicAvatarPath(seed)}" fill="${color}"/><g transform="rotate(${organicAvatarEyeTilt(seed)})">${barEyes(ORGANIC_AVATAR_EYES, botEyeInk(color, lightTokens))}</g>`;
  }
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="${viewBox}">${body}</svg>`)}`;
}

function barEyes(eyes: AvatarEyes, fill: string): string {
  const rects = avatarEyeRects(eyes)
    .map(
      ({ x, y, width, height, rx }) =>
        `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${rx}"/>`,
    )
    .join("");
  return `<g fill="${fill}">${rects}</g>`;
}
