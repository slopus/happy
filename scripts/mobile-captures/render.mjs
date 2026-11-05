import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { root, presets, preset, names } from './paths.mjs';
import { pageHTML, settle, geometry } from './page.mjs';
import { withBrowser } from './browser.mjs';

const { values } = parseArgs({ options: {
  device: { type: 'string', default: 'all' }, out: { type: 'string', default: join(root, 'output') },
  inputs: { type: 'string', default: join(root, 'inputs') }, jobs: { type: 'string', default: '2' },
  card: { type: 'string' }
} });
const devices = values.device === 'all' ? Object.keys(presets) : [values.device];
const cards = values.card ? [Number(values.card)] : [1, 2, 3, 4, 5];
if (cards.some(n => !Number.isInteger(n) || n < 1 || n > 5)) throw Error('--card must be 1..5');
const jobs = Number(values.jobs);
if (!Number.isInteger(jobs) || jobs < 1 || jobs > 4) throw Error('--jobs must be 1..4');
const out = resolve(values.out), inputs = resolve(values.inputs);
await mkdir(out, { recursive: true });
const queue = devices.flatMap(device => cards.map(card => ({ device, card })));
const results = [];
const hash = data => createHash('sha256').update(data).digest('hex');
await withBrowser(async (browser, work) => {
  await Promise.all(Array.from({ length: jobs }, async (_, worker) => {
    let task;
    while ((task = queue.shift())) {
      const { device, card } = task, config = preset(device);
      const [width, height] = config.size;
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: 'light' });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      try {
        const htmlFile = join(work, `${worker}.html`);
        await writeFile(htmlFile, await pageHTML(config, join(inputs, config.inputs)));
        const url = pathToFileURL(htmlFile);
        url.searchParams.set('export', card + config.offset);
        if (config.template === 'tablet') url.searchParams.set('device', config.row);
        url.hash = config.row;
        await page.goto(url.href);
        await settle(page, config, card);
        if (errors.length) throw Error(errors.join('\n'));
        const bounds = await geometry(page);
        if (bounds.card.width !== width || Math.abs(bounds.card.height - height) > 1)
          throw Error(`Unexpected dimensions ${JSON.stringify(bounds)}`);
        const file = `${device}-${String(card).padStart(2, '0')}.png`;
        await page.screenshot({ path: join(out, file), clip: { x: 0, y: 0, width, height } });
        const input = `${config.inputs}/${names[card - 1]}.${config.extension}`;
        results.push({ device, card, file, size: config.size, shaderTime: card === 1 ? config.heroTime ?? 20 : 20, geometry: bounds, input,
          inputSha256: hash(await readFile(join(inputs, input))), sha256: hash(await readFile(join(out, file))) });
        console.log(file);
      } finally { await page.close(); }
    }
  }));
  results.sort((a, b) => a.device.localeCompare(b.device) || a.card - b.card);
  await writeFile(join(out, 'manifest.json'), JSON.stringify({ browser: browser.version(), results }, null, 2) + '\n');
});