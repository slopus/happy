/** Default for deployments and clients connected to older servers. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_MAX_COUNT = 4;
/** Hard ceiling for the configurable per-message limit. */
export const ATTACHMENT_COUNT_CEILING = 100;
/** Shared photo preparation policy for web and mobile composers. */
export const ATTACHMENT_IMAGE_MAX_EDGE = 1_600;
export const ATTACHMENT_IMAGE_QUALITY = 0.7;
export const ARTIFACT_NAME_MAX_LENGTH = 255;
export const ARTIFACT_DESCRIPTION_MAX_LENGTH = 280;
/** Base64 expands payload by 4/3; cap before decode to reject oversize uploads cheaply. */
export const ATTACHMENT_MAX_BASE64_LENGTH = Math.ceil(ATTACHMENT_MAX_BYTES / 3) * 4;

export const ATTACHMENT_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

export type AttachmentImageMimeType = (typeof ATTACHMENT_IMAGE_MIME_TYPES)[number];
const STEP_SCREENSHOT_PROFILE = ";profile=step-screenshot";
/**
 * A screenshot a reply kept so its later turns can see it again. Stored and read like an image
 * attachment, but this type keeps it out of every file list, search and version history.
 */
export const STEP_SCREENSHOT_MIME_TYPES = ATTACHMENT_IMAGE_MIME_TYPES.map(
  (type) => `${type}${STEP_SCREENSHOT_PROFILE}`,
);
export function stepScreenshotMimeType(imageType: AttachmentImageMimeType): string {
  return `${imageType}${STEP_SCREENSHOT_PROFILE}`;
}
export function isStepScreenshotMimeType(mimeType: string): boolean {
  return mimeType.endsWith(STEP_SCREENSHOT_PROFILE);
}
/** The image type a kept screenshot, or an image attachment, shows as; else undefined. */
export function storedImageMimeType(mimeType: string): AttachmentImageMimeType | undefined {
  const type = mimeType.endsWith(STEP_SCREENSHOT_PROFILE)
    ? mimeType.slice(0, -STEP_SCREENSHOT_PROFILE.length)
    : mimeType;
  return (ATTACHMENT_IMAGE_MIME_TYPES as readonly string[]).includes(type)
    ? (type as AttachmentImageMimeType)
    : undefined;
}

export const ATTACHMENT_AUDIO_MIME_TYPES = [
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/mp4",
] as const;

export const ATTACHMENT_FILE_MIME_TYPES = [
  ...ATTACHMENT_AUDIO_MIME_TYPES,
  "video/mp4",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/html",
  "application/json",
  "application/zip",
] as const;

export const ATTACHMENT_ALLOWED_MIME_TYPES = [
  ...ATTACHMENT_IMAGE_MIME_TYPES,
  ...ATTACHMENT_FILE_MIME_TYPES,
] as const;

export type AttachmentMimeType = (typeof ATTACHMENT_ALLOWED_MIME_TYPES)[number];

export function isAttachmentImageMimeType(mimeType: string): boolean {
  return (ATTACHMENT_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType);
}

export type ArtifactPreviewKind = "html" | "markdown" | "pdf" | "image" | "video" | "text" | "none";

const TEXT_APPLICATION_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/javascript",
  "application/x-sh",
  "application/sql",
]);

/** How every client previews a saved file, so web and mobile show the same types. */
export function artifactPreviewKind(mimeType: string): ArtifactPreviewKind {
  const type = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "text/html") return "html";
  if (type === "text/markdown") return "markdown";
  if (type === "application/pdf") return "pdf";
  if (isAttachmentImageMimeType(type)) return "image";
  if (type === "video/mp4") return "video";
  if (type.startsWith("text/") || TEXT_APPLICATION_MIME_TYPES.has(type)) return "text";
  return "none";
}

export function isAttachmentAudioMimeType(mimeType: string): boolean {
  return (ATTACHMENT_AUDIO_MIME_TYPES as readonly string[]).includes(mimeType);
}

export function isAllowedAttachmentMimeType(mimeType: string): mimeType is AttachmentMimeType {
  return (ATTACHMENT_ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType);
}

export function validateThreadsSendInput(input: {
  text?: string;
  artifactIds?: string[];
}): boolean {
  const text = input.text?.trim() ?? "";
  const artifactIds = input.artifactIds ?? [];
  return Boolean(text || artifactIds.length);
}

/** Effective per-file upload limit advertised in me/bootstrap. */
export function attachmentMaxBytes(config?: { maxUploadSizeBytes?: number } | null): number {
  return config?.maxUploadSizeBytes ?? ATTACHMENT_MAX_BYTES;
}

export function attachmentSizeLabel(maxBytes: number): string {
  return `${maxBytes / (1024 * 1024)} MiB`;
}

/** Effective per-message limit, including the fallback for older servers. */
export function attachmentMaxCount(config?: { maxAttachmentsPerMessage?: number } | null): number {
  return config?.maxAttachmentsPerMessage ?? ATTACHMENT_MAX_COUNT;
}
