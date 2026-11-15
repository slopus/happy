import { ATTACHMENT_MAX_BASE64_LENGTH } from "@rakazo/contracts";

const IMAGE_MAX_EDGE = 2048;
const IMAGE_TILE_PIXELS = 512;
const IMAGE_TOKENS_PER_TILE = 170;
const IMAGE_BASE_TOKENS = 85;
const IMAGE_PIXELS_PER_TOKEN = 750;
const MIN_IMAGE_TOKENS = 1024;
const MAX_IMAGE_HEADER_BASE64 = 350_000;

/**
 * Conservative standard-resolution planning policy (not exact provider billing).
 * Fit within 2048² without upscaling, then take the larger of 85 + 170 per
 * 512px tile and area / 750, retaining the 1024-token floor per frame.
 * This bounds OpenAI's standard tile policy (which further reduces the short
 * edge to 768) and Anthropic's standard area policy (which caps at 1568px).
 * https://developers.openai.com/api/docs/guides/images-vision
 * https://platform.claude.com/docs/en/build-with-claude/vision
 * Model-specific high/original-resolution modes can have different costs.
 */
function imageFrameTokens(width: number, height: number): number {
  // Keep implausible header dimensions fail-closed before scaling.
  if (!Number.isSafeInteger(width * height)) return Number.MAX_SAFE_INTEGER;
  const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(width, height));
  const scaledWidth = Math.ceil(width * scale);
  const scaledHeight = Math.ceil(height * scale);
  const tiles =
    Math.ceil(scaledWidth / IMAGE_TILE_PIXELS) * Math.ceil(scaledHeight / IMAGE_TILE_PIXELS);
  return Math.max(
    MIN_IMAGE_TOKENS,
    IMAGE_BASE_TOKENS + tiles * IMAGE_TOKENS_PER_TILE,
    Math.ceil((scaledWidth * scaledHeight) / IMAGE_PIXELS_PER_TOKEN),
  );
}

/** Inspect only image headers. Unsupported or malformed data keeps the byte-based budget. */
function imageDimensions(bytes: Buffer, mimeType: string): [number, number, number] | undefined {
  if (mimeType === "image/png") {
    if (
      bytes.length < 33 ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.readUInt32BE(8) !== 13 ||
      bytes.toString("ascii", 12, 16) !== "IHDR"
    )
      return;
    const dimensions: [number, number] = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
    // APNG frame count lives in acTL before the first IDAT. If that portion of
    // the header does not fit the bounded read, retain the byte fallback.
    let offset = 33;
    let frames = 1;
    let sawAnimationControl = false;
    let firstFrameBeforeImageData = false;
    while (offset + 8 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      if (type === "IEND") return;
      // A default image without an earlier fcTL is separate from acTL's animation frames.
      if (type === "IDAT")
        return [
          ...dimensions,
          sawAnimationControl && !firstFrameBeforeImageData ? frames + 1 : frames,
        ];
      const next = offset + 12 + length;
      if (!Number.isSafeInteger(next) || next > bytes.length) return;
      if (type === "acTL") {
        if (sawAnimationControl || length !== 8) return;
        frames = bytes.readUInt32BE(offset + 8);
        if (frames < 1) return;
        sawAnimationControl = true;
      }
      if (type === "fcTL" && sawAnimationControl) {
        if (length !== 26) return;
        firstFrameBeforeImageData = true;
      }
      offset = next;
    }
    return;
  }
  if (mimeType === "image/webp") {
    if (
      bytes.length < 30 ||
      bytes.toString("ascii", 0, 4) !== "RIFF" ||
      bytes.toString("ascii", 8, 12) !== "WEBP"
    )
      return;
    const format = bytes.toString("ascii", 12, 16);
    if (format === "VP8X") {
      if ((bytes[20]! & 0x02) !== 0) return; // Animated frames need the full RIFF chunk list.
      return [1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3), 1];
    }
    if (format === "VP8L" && bytes[20] === 0x2f) {
      const dimensions = bytes.readUInt32LE(21);
      return [1 + (dimensions & 0x3fff), 1 + ((dimensions >>> 14) & 0x3fff), 1];
    }
    if (format === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a)
      return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff, 1];
    return;
  }
  if (mimeType !== "image/jpeg" || bytes[0] !== 0xff || bytes[1] !== 0xd8) return;
  let offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset++] !== 0xff) return;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xda || marker === 0xd9) return;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > bytes.length) return;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return;
    if (
      length >= 7 &&
      ((marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf))
    )
      return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3), 1];
    offset += length;
  }
}

function gifFrameTokens(bytes: Buffer): number | undefined {
  if (
    bytes.length < 14 ||
    (bytes.toString("ascii", 0, 6) !== "GIF87a" && bytes.toString("ascii", 0, 6) !== "GIF89a")
  )
    return;
  const canvasWidth = bytes.readUInt16LE(6);
  const canvasHeight = bytes.readUInt16LE(8);
  if (canvasWidth < 1 || canvasHeight < 1) return;
  const canvasTokens = imageFrameTokens(canvasWidth, canvasHeight);
  let offset = 13;
  if ((bytes[10]! & 0x80) !== 0) offset += 3 * 2 ** ((bytes[10]! & 7) + 1);
  if (offset >= bytes.length) return;
  let tokens = 0;
  while (offset < bytes.length) {
    const block = bytes[offset++];
    if (block === 0x3b) return tokens > 0 ? tokens : undefined;
    if (block === 0x21) {
      if (offset >= bytes.length) return;
      offset++; // Extension label.
    } else if (block === 0x2c) {
      if (offset + 9 > bytes.length) return;
      const left = bytes.readUInt16LE(offset);
      const top = bytes.readUInt16LE(offset + 2);
      const width = bytes.readUInt16LE(offset + 4);
      const height = bytes.readUInt16LE(offset + 6);
      if (width < 1 || height < 1 || left + width > canvasWidth || top + height > canvasHeight)
        return;
      // A delta frame is composited onto the logical-screen canvas.
      tokens += canvasTokens;
      if (!Number.isSafeInteger(tokens)) return Number.MAX_SAFE_INTEGER;
      const flags = bytes[offset + 8]!;
      offset += 9;
      if ((flags & 0x80) !== 0) offset += 3 * 2 ** ((flags & 7) + 1);
      if (offset >= bytes.length) return;
      const lzwCodeSize = bytes[offset++]!;
      if (lzwCodeSize < 2 || lzwCodeSize > 8) return;
    } else return;
    // Extensions and image data both end with a zero-length sub-block.
    let terminated = false;
    while (offset < bytes.length) {
      const size = bytes[offset++]!;
      if (size === 0) {
        terminated = true;
        break;
      }
      offset += size;
    }
    if (!terminated || offset > bytes.length) return;
  }
}

function animatedWebpFrameTokens(bytes: Buffer): number | undefined {
  if (
    bytes.length < 30 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP" ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  )
    return;
  let offset = 12;
  let canvasWidth = 0;
  let canvasHeight = 0;
  let animationControl = false;
  let tokens = 0;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const next = offset + 8 + length + (length & 1);
    if (!Number.isSafeInteger(next) || next > bytes.length) return;
    if (type === "VP8X") {
      if (canvasWidth || length !== 10 || (bytes[offset + 8]! & 0x02) === 0) return;
      canvasWidth = 1 + bytes.readUIntLE(offset + 12, 3);
      canvasHeight = 1 + bytes.readUIntLE(offset + 15, 3);
    } else if (type === "ANIM") {
      if (!canvasWidth || animationControl || length !== 6) return;
      animationControl = true;
    } else if (type === "ANMF") {
      if (!animationControl || length < 24) return;
      const firstChunkLength = bytes.readUInt32LE(offset + 28);
      if (firstChunkLength < 1 || 24 + firstChunkLength + (firstChunkLength & 1) > length) return;
      const left = bytes.readUIntLE(offset + 8, 3) * 2;
      const top = bytes.readUIntLE(offset + 11, 3) * 2;
      const width = 1 + bytes.readUIntLE(offset + 14, 3);
      const height = 1 + bytes.readUIntLE(offset + 17, 3);
      if (left + width > canvasWidth || top + height > canvasHeight) return;
      tokens += imageFrameTokens(canvasWidth, canvasHeight);
      if (!Number.isSafeInteger(tokens)) return Number.MAX_SAFE_INTEGER;
    }
    offset = next;
  }
  return offset === bytes.length && animationControl && tokens > 0 ? tokens : undefined;
}

/** Bounded-resolution context planning estimate, independent of provider billing. */
export function estimatePiImageTokens(image: object): number | undefined {
  if (!("data" in image) || typeof image.data !== "string") return;
  if (!("mimeType" in image) || typeof image.mimeType !== "string") return;
  // GIF frame descriptors can occur throughout the file. Decode only within the attachment limit.
  if (image.mimeType === "image/gif") {
    if (image.data.length > ATTACHMENT_MAX_BASE64_LENGTH) return;
    return gifFrameTokens(Buffer.from(image.data, "base64"));
  }
  if (image.mimeType === "image/webp" && image.data.length <= ATTACHMENT_MAX_BASE64_LENGTH) {
    const header = Buffer.from(image.data.slice(0, 48), "base64");
    if (header.toString("ascii", 12, 16) === "VP8X" && (header[20]! & 0x02) !== 0) {
      return animatedWebpFrameTokens(Buffer.from(image.data, "base64"));
    }
  }
  // JPEG metadata can precede the frame header; avoid decoding a full image each model call.
  const header = Buffer.from(image.data.slice(0, MAX_IMAGE_HEADER_BASE64), "base64");
  const dimensions = imageDimensions(header, image.mimeType);
  if (!dimensions || dimensions.some((dimension) => !Number.isInteger(dimension) || dimension < 1))
    return;
  const [width, height, frames] = dimensions;
  const tokens = imageFrameTokens(width, height) * frames;
  return Number.isSafeInteger(tokens) ? tokens : Number.MAX_SAFE_INTEGER;
}
