import { readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { root } from './paths.mjs';
import { withBrowser } from './browser.mjs';

const { values } = parseArgs({ options: { device: { type: 'string', default: 'iphone' },
  out: { type: 'string', default: join(root, 'output/background.mp4') }, seconds: { type: 'string', default: '17.5' } } });
const configs = JSON.parse(await readFile(join(root, 'video-presets.json')));
const config = configs[values.device];
if (!config) throw Error('No video preset for ' + values.device);
const [width, height] = config.backgroundSize, frames = Math.round(Number(values.seconds) * 30);
if (!(frames > 0)) throw Error('--seconds must be positive');
await mkdir(dirname(resolve(values.out)), { recursive: true });
await withBrowser(async browser => {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const shared = await readFile(join(root, 'web/cards.js'), 'utf8') + await readFile(join(root, 'web/shader.js'), 'utf8');
  await page.setContent(`<style>body{margin:0}.card{width:${width}px;height:${height}px}</style>
    <div class="row on"><div class="card"><canvas></canvas></div></div><script>${shared}
    window.shaderGrain=0;
    const el=document.querySelector('.card'); const items=[{el,canvas:el.querySelector('canvas'),card:CARDS[0]}];
    ${await readFile(join(root, 'web/paint.js'), 'utf8')}</script>`);
  // Shared GLSL, palette and seed. Grain is added at full resolution by compose-video.py.
  // Offline frames never depend on wall time.
  const encoder = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', '30', '-i', 'pipe:0',
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv444p',
    '-c:v', 'libx264', '-threads', '2', '-crf', '0', '-colorspace', 'bt709',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', resolve(values.out)],
    { stdio: ['pipe', 'inherit', 'inherit'] });
  const finished = once(encoder, 'close');
  let pipeError;
  encoder.stdin.on('error', error => { pipeError = error; });
  try {
    for (let frame = 0; frame < frames; frame++) {
      const png = await page.evaluate(time => {
        window.paint(time); return document.querySelector('canvas').toDataURL('image/png').split(',')[1];
      }, 20 + frame / 30 * .35);
      if (pipeError) throw pipeError;
      if (!encoder.stdin.write(Buffer.from(png, 'base64'))) await once(encoder.stdin, 'drain');
      if (frame % 30 === 0) console.log(`${frame}/${frames}`);
    }
    encoder.stdin.end();
    const [exit] = await finished;
    if (exit !== 0) throw Error('Background encoder failed: ' + exit);
  } finally { if (encoder.exitCode === null) encoder.kill('SIGTERM'); }
});