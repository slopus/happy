import { PNG } from "pngjs";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const MAX_PNG_SCREENSHOT_BYTES = 15 * 1024 * 1024;
const MAX_SCREENSHOT_DIMENSION = 10_000;
const MAX_SCREENSHOT_PIXELS = 50_000_000;

export function validatePngScreenshot(buffer: Buffer, source: string): void {
  if (buffer.length === 0 || buffer.length > MAX_PNG_SCREENSHOT_BYTES) {
    throw new Error(`Invalid screenshot size for ${source}`);
  }
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`Screenshot is not a PNG image: ${source}`);
  }

  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (
    width === 0 ||
    height === 0 ||
    width > MAX_SCREENSHOT_DIMENSION ||
    height > MAX_SCREENSHOT_DIMENSION ||
    width * height > MAX_SCREENSHOT_PIXELS
  ) {
    throw new Error(`Invalid PNG dimensions for ${source}: ${width}x${height}`);
  }

  assertCompleteChunkStream(buffer, source);
  try {
    const decoded = PNG.sync.read(buffer, { checkCRC: true });
    if (decoded.width !== width || decoded.height !== height) {
      throw new Error("decoded dimensions do not match IHDR");
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid PNG screenshot ${source}: ${detail}`);
  }
}

function assertCompleteChunkStream(buffer: Buffer, source: string): void {
  let offset = PNG_SIGNATURE.length;
  let chunkIndex = 0;
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) throw new Error(`Truncated PNG screenshot: ${source}`);
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > buffer.length) throw new Error(`Truncated PNG screenshot: ${source}`);
    if (chunkIndex === 0 && (type !== "IHDR" || length !== 13)) {
      throw new Error(`Invalid PNG header for ${source}`);
    }
    if (type === "IEND") {
      if (length !== 0 || chunkEnd !== buffer.length) {
        throw new Error(`Invalid PNG end for ${source}`);
      }
      return;
    }
    offset = chunkEnd;
    chunkIndex += 1;
  }
  throw new Error(`PNG screenshot is missing IEND: ${source}`);
}
