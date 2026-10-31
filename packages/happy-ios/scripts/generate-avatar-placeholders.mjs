#!/usr/bin/env node
// Renders every avatar on shaders.craftedstudios.co's front page to the
// still pictures in Sources/HappyUI/Resources/AvatarPlaceholders.
//
// The page is a wall of five effects, 40 seeds each. Each one is drawn by the
// page's own still exporter (@craftedstudios/shaders `toBlob`: one frame at
// the seed's phase) as a 1024px square, then scaled to 384px (Settings' 100pt
// agent picture at 3x, with room) and encoded as WebP at quality 80, which
// keeps the shaders' grain. The wall's order is the files' order:
// avatar-placeholder-001 is the first linear seed, 200 the last plasma one.
//
// Needs playwright-core, a Chromium (PLAYWRIGHT_CHROMIUM, else Playwright's
// cached one), ImageMagick's `magick` and libwebp's `cwebp`:
//
//   npm i --no-save playwright-core
//   node scripts/generate-avatar-placeholders.mjs
//
// @craftedstudios/shaders is MIT, Copyright (c) 2026 Crafted Studios; its
// notice travels with the pictures (AvatarPlaceholders/LICENSE-craftedstudios-shaders.txt).
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const site = 'https://shaders.craftedstudios.co/';
const out = new URL('../Sources/HappyUI/Resources/AvatarPlaceholders/', import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), 'avatar-placeholders-'));
mkdirSync(out, { recursive: true });

function chromiumPath() {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  const newest = readdirSync(cache).filter((name) => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))[0];
  return join(cache, newest, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
}

const browser = await chromium.launch({ executablePath: chromiumPath(), headless: true, args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.goto(site, { waitUntil: 'networkidle' });
await page.waitForSelector('.card[data-seed]');
const wall = await page.evaluate(() =>
  [...document.querySelectorAll('.chapter')].flatMap((chapter) =>
    [...chapter.querySelectorAll('.card[data-seed]')].map((card) => ({ seed: card.dataset.seed, effect: chapter.getAttribute('aria-label').toLowerCase() })),
  ),
);
const still = await page.evaluate(() => [...document.querySelectorAll('link[rel=modulepreload]')].map((link) => link.href).find((href) => href.includes('/still-')));
if (wall.length === 0 || !still) throw new Error('The page has no wall or no still exporter');

const rows = [];
for (const [index, { seed, effect }] of wall.entries()) {
  const base64 = await page.evaluate(async ({ still, seed, effect }) => {
    const { t: toBlob } = await import(still);
    const bytes = new Uint8Array(await (await toBlob(seed, { effect, size: 1024, shape: 'square' })).arrayBuffer());
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(text);
  }, { still, seed, effect });
  const number = String(index + 1).padStart(3, '0');
  const png = join(work, `${number}.png`);
  const small = join(work, `${number}-384.png`);
  writeFileSync(png, Buffer.from(base64, 'base64'));
  execFileSync('magick', [png, '-filter', 'Lanczos', '-resize', '384x384', '-strip', small]);
  execFileSync('cwebp', ['-quiet', '-q', '80', '-m', '6', '-metadata', 'none', small, '-o', join(out, `avatar-placeholder-${number}.webp`)]);
  rows.push(`| \`avatar-placeholder-${number}.webp\` | \`${seed}\` | ${effect} |`);
}
await browser.close();
writeFileSync(join(work, 'rows.md'), rows.join('\n') + '\n');
console.log(`${wall.length} pictures in ${out}; PROVENANCE rows in ${join(work, 'rows.md')}`);
