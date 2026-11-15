import { createHash } from "node:crypto";
import { notificationAvatarSource } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";

/** Installed apps drop an avatar over 1400 base64 characters, and Android one over 96px. */
const MAX_AVATAR_BYTES = 1050;
/** Largest that fits first; iOS draws the sender at about 40pt, so 40px alone looked blurry. */
const AVATAR_SIZES = [96, 64, 40];
/** The iOS notification circle is 40pt, drawn at up to 120 physical pixels on a 3x screen. */
const LARGE_AVATAR_SIDE = 120;
const MAX_CACHED_AVATARS = 1000;
/**
 * Thumbnails by bot id, keyed on the avatar inputs so an edited avatar renders again. The render
 * is stored before it settles, so concurrent sends share it and a failed render is not retried.
 */
type RenderedAvatar = { avatar: string | undefined; avatarLarge: string | undefined };
const avatars = new Map<string, { key: string; avatar: Promise<RenderedAvatar | undefined> }>();

async function renderAvatar(bot: { id: string; color: string; avatarSet?: string | null }) {
  const source = notificationAvatarSource(bot);
  const comma = source.indexOf(",");
  const drawn = source.startsWith("data:image/svg+xml,");
  const bytes = drawn
    ? Buffer.from(decodeURIComponent(source.slice(comma + 1)))
    : Buffer.from(source.slice(comma + 1), "base64");
  const { default: sharp } = await import("sharp");
  const image = sharp(bytes, { limitInputPixels: 16_777_216 }).rotate();
  // A drawn avatar is two-tone art, which JPEG quality 30 softens around every edge. A small
  // palette PNG stays sharp within the same payload budget; saved photos keep JPEG.
  const encode = (size: number) => {
    const resized = image
      .clone()
      .resize(size, size, { fit: "cover" })
      .flatten({ background: "white" });
    return (
      drawn
        ? resized.png({ palette: true, colours: 16, effort: 10 })
        : resized.jpeg({ quality: 30, mozjpeg: true })
    ).toBuffer();
  };
  const fits = async (sizes: number[]) => {
    for (const size of sizes) {
      const avatar = await encode(size);
      if (avatar.length <= MAX_AVATAR_BYTES) return avatar.toString("base64");
    }
    return undefined;
  };
  const avatar = await fits(AVATAR_SIZES);
  // Only the 120px candidate can differ from `avatar`; a smaller fallback would repeat it
  // byte for byte, and the identity below omits an equal one. A photo reaches the 120px
  // candidate as JPEG when one fits the budget; a detailed photo that cannot keeps the
  // thumbnail, since no harder encoding fits the budget at that detail.
  const avatarLarge = await fits([LARGE_AVATAR_SIDE]);
  return { avatar, avatarLarge };
}

/** Small enough to travel inside a push without exposing an authenticated avatar URL. */
export async function notificationIdentity(bot: {
  id: string;
  name: string;
  color: string;
  avatarSet?: string | null;
}) {
  const key = createHash("sha256")
    .update(`${bot.avatarSet ?? ""}\n${bot.color}`)
    .digest("base64url");
  let cached = avatars.get(bot.id);
  if (cached?.key !== key) {
    cached = {
      key,
      avatar: renderAvatar(bot).catch((error: unknown) => {
        getLogger().error("notification avatar", error);
        return undefined;
      }),
    };
    avatars.delete(bot.id);
    if (avatars.size >= MAX_CACHED_AVATARS) avatars.delete(avatars.keys().next().value!);
    avatars.set(bot.id, cached);
  }
  const rendered = await cached.avatar;
  return {
    botId: bot.id,
    name: bot.name.trim().slice(0, 100) || "Bot",
    ...(rendered?.avatar ? { avatar: rendered.avatar } : {}),
    ...(rendered?.avatarLarge ? { avatarLarge: rendered.avatarLarge } : {}),
  };
}
