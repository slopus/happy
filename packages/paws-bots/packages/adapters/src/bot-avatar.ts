import type { MessageBlock } from "@rakazo/contracts";
import { BOT_AVATAR_VALUE_MAX_LENGTH, isBotAvatarValue } from "@rakazo/contracts";

export const BOT_AVATAR_ENCODE_SIZE = 256;

export function attachedImageArtifactIds(blocks: MessageBlock[] | undefined): string[] {
  if (!blocks?.length) return [];
  return blocks
    .filter((block): block is Extract<MessageBlock, { kind: "image" }> => block.kind === "image")
    .map((block) => block.artifactId);
}

export async function encodeBotAvatarImage(bytes: Uint8Array): Promise<string> {
  // sharp is a native addon; load it only when an image is processed.
  const { default: sharp } = await import("sharp");
  const webp = await sharp(bytes)
    .rotate()
    .resize(BOT_AVATAR_ENCODE_SIZE, BOT_AVATAR_ENCODE_SIZE, {
      fit: "cover",
      position: "centre",
    })
    .webp({ quality: 90 })
    .toBuffer();
  const dataUrl = `data:image/webp;base64,${webp.toString("base64")}`;
  if (dataUrl.length > BOT_AVATAR_VALUE_MAX_LENGTH) {
    throw new Error("Avatar image is too large");
  }
  return dataUrl;
}

export async function resolveUpdateBotAvatar(input: {
  color?: unknown;
  artifactId?: unknown;
  useAttachedImage?: unknown;
  sourceImageArtifactIds: readonly string[];
  loadArtifact: (id: string) => Promise<Uint8Array | null>;
}): Promise<{ color: string } | { error: string }> {
  const artifactId =
    typeof input.artifactId === "string" && input.artifactId.trim()
      ? input.artifactId.trim()
      : undefined;
  const useAttachedImage = input.useAttachedImage === true;
  const color = typeof input.color === "string" ? input.color.trim() : undefined;

  const imageId =
    artifactId ?? (useAttachedImage ? input.sourceImageArtifactIds.at(-1) : undefined);

  if (imageId) {
    const bytes = await input.loadArtifact(imageId);
    if (!bytes) {
      return { error: "Image is not in this space or is not an attached picture." };
    }
    try {
      return { color: await encodeBotAvatarImage(bytes) };
    } catch {
      return { error: "Could not use that image as an avatar." };
    }
  }

  if (useAttachedImage) {
    return { error: "No attached image on this message." };
  }

  if (color !== undefined) {
    if (!isBotAvatarValue(color)) {
      return {
        error:
          "color must be a hex value, an encoded shape like #8B5CF6::shape_3, or a data image.",
      };
    }
    return { color };
  }

  return { error: "missing" };
}
