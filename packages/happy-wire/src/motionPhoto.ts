export type MotionPhotoVideo = {
  videoOffset: number;
  videoLength: number;
  mimeType: 'video/mp4';
};

const HONOR_MARKER = new TextEncoder().encode('HiHonor_OfflineData\0');

function findSequence(bytes: Uint8Array, needle: Uint8Array): number {
  outer: for (let offset = 0; offset <= bytes.length - needle.length; offset += 1) {
    for (let index = 0; index < needle.length; index += 1) {
      if (bytes[offset + index] !== needle[index]) continue outer;
    }
    return offset;
  }
  return -1;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000
    + bytes[offset + 1] * 0x10000
    + bytes[offset + 2] * 0x100
    + bytes[offset + 3]
  );
}

function readUint64BE(bytes: Uint8Array, offset: number): number | null {
  const high = readUint32BE(bytes, offset);
  const low = readUint32BE(bytes, offset + 4);
  const value = high * 0x100000000 + low;
  return Number.isSafeInteger(value) ? value : null;
}

function boxType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

/** Locate the playable MP4 embedded after an Honor dynamic JPEG cover. */
export function detectHonorMotionPhoto(bytes: Uint8Array): MotionPhotoVideo | null {
  if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  const markerOffset = findSequence(bytes, HONOR_MARKER);
  if (markerOffset < 0) return null;
  const videoOffset = markerOffset + HONOR_MARKER.length;
  let offset = videoOffset;
  let first = true;
  let hasMovieBox = false;

  while (offset + 8 <= bytes.length) {
    let size = readUint32BE(bytes, offset);
    const type = boxType(bytes, offset + 4);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > bytes.length) return null;
      const extendedSize = readUint64BE(bytes, offset + 8);
      if (extendedSize === null) return null;
      size = extendedSize;
      headerSize = 16;
    } else if (size === 0) {
      size = bytes.length - offset;
    }

    if (first && type !== 'ftyp') return null;
    if (type === 'uuid') break;
    if (size < headerSize || offset + size > bytes.length) break;
    if (type === 'moov') hasMovieBox = true;
    offset += size;
    first = false;
  }

  const videoLength = offset - videoOffset;
  return !first && hasMovieBox && videoLength > 0
    ? { videoOffset, videoLength, mimeType: 'video/mp4' }
    : null;
}
