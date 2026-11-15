import { ATTACHMENT_IMAGE_MAX_EDGE, ATTACHMENT_IMAGE_QUALITY } from "@rakazo/contracts";
import { inferAttachmentMimeType, isStaticPng, PNG_ANIMATION_HEADER_BYTES } from "@rakazo/core";

// Recompress byte-heavy images even when their dimensions already fit.
const IMAGE_RECOMPRESS_BYTES = 5 * 1024 * 1024;

export function canPrepareImage(file: File): boolean {
  const mimeType = inferAttachmentMimeType(file.name, file.type);
  // Canvas encodes a single frame. Preserve formats that can contain animations,
  // matching the mobile picker rather than flattening animated WebP uploads.
  return mimeType === "image/jpeg" || mimeType === "image/png";
}

/** Best effort: unsupported browsers and unreadable images retain the original upload. */
export async function prepareImage(file: File): Promise<File> {
  if (!canPrepareImage(file)) return file;
  let image: ImageBitmap | undefined;
  try {
    if (inferAttachmentMimeType(file.name, file.type) === "image/png") {
      const header = new Uint8Array(await file.slice(0, PNG_ANIMATION_HEADER_BYTES).arrayBuffer());
      if (!isStaticPng(header)) return file;
    }
    image = await createImageBitmap(file);
    const edge = Math.max(image.width, image.height);
    if (edge <= ATTACHMENT_IMAGE_MAX_EDGE && file.size < IMAGE_RECOMPRESS_BYTES) return file;
    const scale = Math.min(1, ATTACHMENT_IMAGE_MAX_EDGE / edge);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const mimeType = inferAttachmentMimeType(file.name, file.type)!;
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, mimeType, ATTACHMENT_IMAGE_QUALITY),
    );
    // Browsers may silently encode PNG when the requested format is unsupported.
    if (!blob?.size || blob.type !== mimeType) return file;
    return new File([blob], file.name, { type: mimeType, lastModified: file.lastModified });
  } catch {
    return file;
  } finally {
    image?.close();
  }
}
