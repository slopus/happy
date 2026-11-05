import { mkdir, readFile, writeFile, copyFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { root } from './paths.mjs';
import { screenMask } from './mask.mjs';

// Apple artwork stays outside git under its own design-resource terms.
// Pass a downloaded PNG/DMG, or --download to fetch the pinned upstream asset.
const [kind, input] = process.argv.slice(2);
if (!['iphone', 'duo', 'android'].includes(kind)) throw Error('Usage: node artwork.mjs iphone|duo|android [PATH|--download]');
const cache = join(root, '.cache/frames');
await mkdir(cache, { recursive: true });
const sha = data => createHash('sha256').update(data).digest('hex');
function verify(data, expected) { if (sha(data) !== expected) throw Error(`Artwork SHA-256 mismatch: expected ${expected}, got ${sha(data)}`); }
async function get(url) {
  const response = await fetch(url);
  if (!response.ok) throw Error(`${response.status} fetching ${url}`);
  return Buffer.from(await response.arrayBuffer());
}
if (kind === 'android') {
  for (const name of ['pixel9-back.webp', 'pixel9-mask.webp']) await copyFile(join(root, 'assets/pixel9', name), join(cache, name));
} else if (kind === 'iphone') {
  let data;
  if (input === '--download') {
    const url = 'https://api.github.com/repos/jamesjingyi/mockup-device-frames/git/blobs/aac753fd235a3efbaa8c6a382659c1701862fa95';
    const blob = JSON.parse((await get(url)).toString());
    data = Buffer.from(blob.content, 'base64');
  } else if (input) data = await readFile(resolve(input));
  else throw Error('Supply the Apple iPhone 16 Pro Black Titanium PNG or --download');
  verify(data, 'f56d27cb5b70d5adeb8f5fcb7e5c386ffb441a6a23417d0f3f62cbbd93823962');
  const frame = join(cache, 'iphone-16-pro-black.png');
  await writeFile(frame, data);
  await screenMask(frame, { x: 102, y: 100, width: 1206, height: 2622 }, join(cache, 'screen-alpha.png'));
  verify(await readFile(join(cache, 'screen-alpha.png')), '4f9ba9b803e6377e2d4dc67af78a954ef3abe558d8da528884109c4ca8ed2bf9');
} else {
  if (process.platform !== 'darwin') throw Error('Import the Duo DMG on macOS, then rsync .cache/frames to the renderer');
  const source = JSON.parse(await readFile(join(root, 'web/duo-artwork.json')));
  const work = await mkdtemp(join(root, '.cache/artwork-'));
  let mounted = false;
  try {
    const data = input === '--download' ? await get(source.url) : await readFile(resolve(input));
    verify(data, source.dmgSha256);
    const dmg = join(work, 'artwork.dmg'), mount = join(work, 'mounted');
    await writeFile(dmg, data); await mkdir(mount);
    execFileSync('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmg], { stdio: 'inherit' });
    mounted = true;
    const files = await readdir(mount, { recursive: true });
    for (const [name, frame] of Object.entries(source.frames)) {
      const path = files.find(file => file.split('/').at(-1) === frame.appleFilename);
      if (!path) throw Error(`Missing ${frame.appleFilename}`);
      const png = await readFile(join(mount, path)); verify(png, frame.sha256);
      const output = join(cache, frame.file); await writeFile(output, png);
      await screenMask(output, frame.screen, join(cache, `${name}-screen-mask.png`));
      verify(await readFile(join(cache, `${name}-screen-mask.png`)), frame.maskSha256);
    }
  } finally {
    if (mounted) execFileSync('hdiutil', ['detach', join(work, 'mounted')], { stdio: 'inherit' });
    await rm(work, { recursive: true, force: true });
  }
}
console.log(cache);