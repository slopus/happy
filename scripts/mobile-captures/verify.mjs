import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { root } from './paths.mjs';
import { approvedPSNR } from './compare.mjs';

// Verify committed inputs and any render's dimensions, geometry and manifest hashes.
const hash = data => createHash('sha256').update(data).digest('hex');
const sources = JSON.parse(await readFile(join(root, 'inputs/SHA256SUMS.json')));
for (const [file, expected] of Object.entries(sources)) {
  if (hash(await readFile(join(root, 'inputs', file))) !== expected) throw Error('Changed source: ' + file);
}
if (process.argv[2]) {
  const out = resolve(process.argv[2]);
  const manifest = JSON.parse(await readFile(join(out, 'manifest.json')));
  const previous = new Map();
  for (const item of manifest.results) {
    const data = await readFile(join(out, item.file)), info = await sharp(data).metadata();
    await approvedPSNR(data, item.file);
    if (hash(data) !== item.sha256 || info.width !== item.size[0] || info.height !== item.size[1]) throw Error('Bad export: ' + item.file);
    const { device, screen } = item.geometry;
    if (screen.x < 0 || screen.y < 0 || screen.x + screen.width > info.width + 1 || screen.y + screen.height > info.height + 1)
      throw Error('Clipped screen: ' + item.file);
    if (previous.has(item.device) && JSON.stringify(previous.get(item.device)) !== JSON.stringify(device))
      throw Error('Device moved between cards: ' + item.file);
    previous.set(item.device, device);
  }
  console.log(`Verified ${manifest.results.length} exports`);
}
console.log(`Verified ${Object.keys(sources).length} committed inputs`);