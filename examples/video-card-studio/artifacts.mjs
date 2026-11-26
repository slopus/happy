/** Bounded PNG validation and standards-compliant uncompressed ZIP, no shell or external archive URLs. */
import { inflateSync } from 'node:zlib';
import { readFile, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { StudioError } from './store.mjs';
const table = Array.from({ length: 256 }, (_, n) => { for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
export function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
export const artifactName = value => { if (!/^card-\d{3}\.png$/.test(value)) throw new StudioError('invalid-artifact'); return value; };
export function validatePNG(bytes) {
  if (bytes.length < 50 || bytes.length > 6 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new StudioError('invalid-png');
  let at = 8, dimensions, channels, ended = false, dataEnded = false; const imageData = [];
  while (at + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(at), type = bytes.toString('ascii', at + 4, at + 8), end = at + 12 + length;
    if (end > bytes.length || crc32(bytes.subarray(at + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) throw new StudioError('invalid-png');
    if (at === 8) {
      if (type !== 'IHDR' || length !== 13) throw new StudioError('invalid-png');
      dimensions = { width: bytes.readUInt32BE(at + 8), height: bytes.readUInt32BE(at + 12) };
      if (dimensions.width < 1 || dimensions.width > 2160 || dimensions.height < 1 || dimensions.height > 12000 || bytes[at + 16] !== 8 || ![2, 6].includes(bytes[at + 17])) throw new StudioError('invalid-png');
      channels = bytes[at + 17] === 2 ? 3 : 4;
      if (bytes[at + 18] !== 0 || bytes[at + 19] !== 0 || bytes[at + 20] !== 0) throw new StudioError('invalid-png');
    } else if (type === 'IHDR') throw new StudioError('invalid-png');
    if (type === 'IDAT') { if (dataEnded) throw new StudioError('invalid-png'); imageData.push(bytes.subarray(at + 8, end - 4)); }
    else if (imageData.length) dataEnded = true;
    if (!['IHDR', 'IDAT', 'IEND', 'PLTE'].includes(type) && (bytes[at + 4] & 32) === 0) throw new StudioError('invalid-png');
    at = end;
    if (type === 'IEND') { if (length !== 0 || at !== bytes.length) throw new StudioError('invalid-png'); ended = true; break; }
  }
  if (!ended || !imageData.length) throw new StudioError('invalid-png');
  try {
    const rowBytes = 1 + dimensions.width * channels, expected = rowBytes * dimensions.height;
    const pixels = inflateSync(Buffer.concat(imageData), { maxOutputLength: expected });
    if (pixels.length !== expected) throw new Error('scanline length');
    for (let row = 0; row < dimensions.height; row++) if (pixels[row * rowBytes] > 4) throw new Error('filter');
  } catch { throw new StudioError('invalid-png'); }
  return dimensions;
}

/** Write once at completion. Memory is bounded by one card, independent of downloads. */
export async function writeZipArchive(directory, cards) {
  const temporary = join(directory, `zip-${randomUUID()}.tmp`), handle = await open(temporary, 'wx', 0o600);
  let offset = 0; const entries = [];
  try {
    for (const card of cards) {
      const name = Buffer.from(artifactName(card.file)), bytes = await readFile(join(directory, card.file));
      if (createHash('sha256').update(bytes).digest('hex') !== card.sha256) throw new StudioError('artifact-changed', 409);
      const crc = crc32(bytes), header = Buffer.alloc(30), central = Buffer.alloc(46);
      header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc, 14);
      header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
      central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16);
      central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
      await handle.writeFile(header); await handle.writeFile(name); await handle.writeFile(bytes);
      entries.push(central, name); offset += 30 + name.length + bytes.length;
    }
    const central = Buffer.concat(entries), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(cards.length, 8); end.writeUInt16LE(cards.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
    await handle.writeFile(central); await handle.writeFile(end); await handle.sync();
    await handle.close(); await rename(temporary, join(directory, 'cards.zip'));
  } finally { await handle.close().catch(() => {}); await rm(temporary, { force: true }); }
}
export function makeZip(files) {
  let offset = 0; const data = [], directory = [];
  for (const { name, bytes } of files) {
    const filename = Buffer.from(artifactName(name)), crc = crc32(bytes);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
    data.push(header, filename, bytes);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    directory.push(central, filename); offset += header.length + filename.length + bytes.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...data, central, end]);
}
