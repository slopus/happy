#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import { resolve, dirname, extname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timestamp, normalizeTranscript, toSrt, validatePlan, readJson } from './lib.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const [command, ...argv] = process.argv.slice(2);
const options = {};
for (let i = 0; i < argv.length; i += 2) {
  if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error('参数应为 --名称 值');
  options[argv[i].slice(2)] = argv[i + 1];
}
const run = (bin, args) => new Promise((accept, reject) => {
  const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  p.stdout.on('data', s => { out += s; }); p.stderr.on('data', s => { err = (err + s).slice(-6000); });
  p.on('error', reject);
  p.on('close', code => code === 0 ? accept(out) : reject(new Error(`${basename(bin)} 退出 ${code}：${err.replace(/https?:\/\/\S+/g, '[网址已省略]')}`)));
});
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const required = name => { if (!options[name]) throw new Error(`缺少 --${name}`); return options[name]; };
const help = `视频图文工具\nprepare --input 视频路径或URL --out 输出目录 [--transcript 字幕文件] [--python Python路径] [--model MLX模型或本地目录]\nvalidate --out 输出目录 --plan 内容计划.json\nframes --out 输出目录 --plan 内容计划.json\nrender --out 输出目录 --plan 内容计划.json [--python Python路径] [--font 中文字体路径] [--max-height 2600]\n`;

async function main() {
  if (!command || command === 'help' || command === '--help') { console.log(help); return; }
  const out = resolve(required('out')); await mkdir(out, { recursive: true });
  const python = options.python || process.env.VIDEO_CARDS_PYTHON || 'python3';
  if (command === 'prepare') {
    const input = required('input');
    let source; let video;
    if (/^https?:\/\//.test(input)) {
      const downloader = process.env.YT_DLP_BIN || 'yt-dlp';
      const metadata = JSON.parse(await run(downloader, ['--skip-download', '--dump-single-json', '--no-warnings', '--socket-timeout', '30', input]));
      source = { title: metadata.title, author: metadata.uploader || metadata.channel || '作者未确认', url: metadata.webpage_url || input, id: metadata.id };
      // 不写入完整 info.json：它可能包含临时签名地址与账户信息。
      await run(downloader, ['--no-playlist', '--no-warnings', '--socket-timeout', '30', '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b', '--merge-output-format', 'mp4', '-o', join(out, 'source.%(ext)s'), input]);
      video = join(out, `source.${metadata.ext || 'mp4'}`);
      try { await stat(join(out, 'source.mp4')); video = join(out, 'source.mp4'); } catch { /* 单流格式沿用原扩展名。 */ }
    } else {
      const inputPath = resolve(input); video = join(out, `source${extname(inputPath)}`);
      if (inputPath !== video) await copyFile(inputPath, video);
      source = { title: options.title || basename(inputPath, extname(inputPath)), author: options.author || '作者未确认', url: options.url || null };
    }
    const probe = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', video]));
    source.duration = Number(probe.format.duration); source.video = basename(video);
    const visual = probe.streams.find(s => s.codec_type === 'video');
    if (!visual) throw new Error('输入没有视频画面');
    source.width = visual.width; source.height = visual.height;
    await save(join(out, 'source.json'), source);
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-vn', '-ac', '1', '-ar', '16000', join(out, 'audio.wav')]);
    let raw; let format; let transcriptSource;
    if (options.transcript) {
      const path = resolve(options.transcript); format = extname(path).slice(1).toLowerCase();
      if (!['json', 'srt', 'vtt'].includes(format)) throw new Error('字幕支持 JSON、SRT、VTT');
      raw = await readFile(path, 'utf8'); transcriptSource = 'provided';
      if (path !== join(out, `transcript-original.${format}`)) await copyFile(path, join(out, `transcript-original.${format}`));
    } else {
      console.log('正在本地转写；长视频请串行处理。');
      const target = join(out, 'transcript-original.json');
      await run(python, [join(scriptDir, 'transcribe.py'), join(out, 'audio.wav'), target, options.model || 'mlx-community/whisper-large-v3-turbo']);
      raw = await readFile(target, 'utf8'); format = 'json'; transcriptSource = 'local-asr';
    }
    const segments = normalizeTranscript(raw, format);
    await save(join(out, 'transcript.json'), { source: transcriptSource, segments });
    await writeFile(join(out, 'transcript.srt'), toSrt(segments));
    await writeFile(join(out, 'transcript.md'), `# ${source.title}\n\n字幕来源：${transcriptSource}。自动转写尚需对照音频校对。\n\n` + segments.map(s => `${s.id} [${s.start.toFixed(2)}–${s.end.toFixed(2)}] ${s.text}`).join('\n\n') + '\n');
    console.log(`素材就绪：${segments.length} 段字幕；下一步由 AI 通读字幕并分析对应画面。`);
    return;
  }
  const plan = await readJson(resolve(required('plan')));
  const source = await readJson(join(out, 'source.json'));
  const { segments } = await readJson(join(out, 'transcript.json'));
  const evidence = validatePlan(plan, segments, source);
  if (command === 'validate') {
    await save(join(out, 'evidence.json'), evidence);
    console.log(`通过：${plan.cards.length} 组内容，${evidence.length} 段带字幕依据的正文。语义与选帧效果仍须人工或 AI 看图复核。`);
  } else if (command === 'frames') {
    await mkdir(join(out, 'frames'), { recursive: true });
    const manifest = [];
    for (const card of plan.cards) {
      const entries = [{ key: `${card.id}-hero`, visual: card.visual }, ...card.blocks.map((b, i) => ({ key: `${card.id}-${i + 1}`, visual: b.visual }))].filter(e => e.visual);
      for (const entry of entries) {
        const time = timestamp(entry.visual.time);
        const candidates = [];
        for (const [label, offset] of [['before', -0.7], ['at', 0], ['after', 0.7]]) {
          const actual = Math.max(0, Math.min(source.duration - 0.04, time + offset));
          const file = `frames/${entry.key}-${label}.jpg`;
          await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(actual), '-i', join(out, source.video), '-frames:v', '1', '-q:v', '2', join(out, file)]);
          candidates.push({ time: actual, file });
        }
        manifest.push({ key: entry.key, selected: candidates[1].file, role: entry.visual.role, reason: entry.visual.reason, candidates });
      }
    }
    await save(join(out, 'frames.json'), manifest);
    await save(join(out, 'evidence.json'), evidence);
    console.log(`已提取 ${manifest.length} 组候选帧。看图后在 frames.json 选择 selected，再 render。`);
  } else if (command === 'render') {
    const args = [join(scriptDir, 'render.py'), '--out', out, '--plan', resolve(options.plan), '--max-height', options['max-height'] || '12000'];
    if (options.font) args.push('--font', options.font);
    console.log(await run(python, args));
  } else throw new Error(`未知命令：${command}\n${help}`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
