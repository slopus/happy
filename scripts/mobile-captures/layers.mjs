import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { root, preset } from './paths.mjs';
import { pageHTML, settle, geometry } from './page.mjs';
import { withBrowser } from './browser.mjs';
import sharp from 'sharp';

const { values } = parseArgs({ options: { device: { type: 'string', default: 'iphone' },
  out: { type: 'string', default: join(root, 'output/layers') } } });
const config = preset(values.device);
const video = JSON.parse(await readFile(join(root, 'video-presets.json')))[values.device];
if (!video) throw Error('No video preset for ' + values.device);
const out = resolve(values.out), [width, height] = video.renderSize;
await mkdir(out, { recursive: true });
await withBrowser(async (browser, temp) => {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const html = join(temp, 'layers.html');
  await writeFile(html, await pageHTML(config, join(root, 'inputs', config.inputs)));
  const url = pathToFileURL(html);
  url.searchParams.set('export', 1 + config.offset);
  if (config.template === 'tablet') url.searchParams.set('device', config.row);
  url.hash = config.row;
  await page.goto(url.href); await settle(page, config);
  const bounds = await geometry(page);
  await page.addStyleTag({ content: 'html,body,.card{background:transparent!important}.card canvas{visibility:hidden!important}.screen{filter:brightness(0)!important}' });
  const overlay = await page.screenshot({ omitBackground: true });
  await page.addStyleTag({ content: 'html,body,.card{background:black!important}.copy,.frame,.back,.mask{visibility:hidden!important}.phone,.device{filter:none!important}.screen{filter:brightness(0) invert(1)!important}' });
  // Retain the real screen's rounded outline/mask, with a flat white interior.
  await page.evaluate(() => document.querySelectorAll('.screen').forEach(image => {
    image.src = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxIiBoZWlnaHQ9IjEiPjxyZWN0IHdpZHRoPSIxIiBoZWlnaHQ9IjEiIGZpbGw9IndoaXRlIi8+PC9zdmc+';
    image.style.objectFit = 'fill';
  }));
  await page.evaluate(() => Promise.all([...document.images].map(image => image.decode())));
  await page.screenshot({ path: join(out, 'mask.png') });
  const rgba = await sharp(overlay).ensureAlpha().raw().toBuffer();
  const mask = await sharp(join(out, 'mask.png')).greyscale().raw().toBuffer();
  for (let i = 0; i < mask.length; i++) {
    // A frameless screen already contributes mask alpha to this black matte.
    // Subtract it so rounded edges do not get darkened a second time.
    rgba[i * 4 + 3] = config.row === 'ipad' ? Math.max(0, rgba[i * 4 + 3] - mask[i])
      : Math.round(rgba[i * 4 + 3] * (1 - mask[i] / 255));
  }
  await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toFile(join(out, 'overlay.png'));
  await writeFile(join(out, 'geometry.json'), JSON.stringify({ ...video, ...bounds }, null, 2) + '\n');
});