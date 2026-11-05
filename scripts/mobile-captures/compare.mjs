import sharp from 'sharp';
import { join } from 'node:path';
import { root } from './paths.mjs';

// Small approved composites catch wrong presets, palettes, inputs and layout drift.
// Compare pixels after downsampling so PNG compression and tiny raster differences
// do not turn a visual regression check into an unstable byte comparison.
export async function approvedPSNR(image, name) {
  const actual = await sharp(image).resize({ width: 160 }).removeAlpha().raw().toBuffer();
  const expected = await sharp(join(root, 'references', name)).removeAlpha().raw().toBuffer();
  if (actual.length !== expected.length) throw Error('Approved aspect ratio changed: ' + name);
  let error = 0;
  for (let i = 0; i < actual.length; i++) error += (actual[i] - expected[i]) ** 2;
  const psnr = error === 0 ? Infinity : 10 * Math.log10(255 ** 2 / (error / actual.length));
  if (psnr < 30) throw Error(`${name}: differs from approved composition (${psnr.toFixed(1)} dB; minimum 30)`);
  return psnr;
}