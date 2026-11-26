import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, realpath, rename, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkpoint, readJSON, writeJSON, run, safeError, digest } from './io.mjs';
import { acquireEpisode, BVID } from './bilibili.mjs';
import { generatePlan, selectFrames, validateInput } from './plan.mjs';
import { archiveCards } from './archive.mjs';
import { proofreadTranscript } from './proofread.mjs';

export async function probeSource(dir, metadata, options = {}) {
  assert(BVID.test(metadata.bvid) && Number.isSafeInteger(metadata.uid) && metadata.uid > 0, '作品或作者身份无效');
  assert.equal(metadata.source, `https://www.bilibili.com/video/${metadata.bvid}/`);
  assert.equal(metadata.page, 1, '多P需单独核对');
  const sourcePath = options.sourcePath || join(dir, 'source.mp4');
  const probe = JSON.parse(await (options.run || run)(options.ffprobe || 'ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', sourcePath], options));
  const duration = Number(probe.format?.duration);
  assert(duration > 0 && duration <= 3600 && Math.abs(duration - metadata.duration) <= 2, '独立媒体时长与页面不一致');
  assert(probe.streams.some(s => s.codec_type === 'video') && probe.streams.some(s => s.codec_type === 'audio'), '源文件缺少音视频轨');
  const bytes = Number(probe.format.size);
  assert(Number.isSafeInteger(bytes) && bytes > 0 && bytes === (await stat(sourcePath)).size, '媒体大小与独立探测不一致');
  return { duration, bytes, width: probe.streams.find(s => s.codec_type === 'video').width };
}

async function fileFingerprint(path) {
  const before = await stat(path);
  assert(before.isFile() && before.size > 0, '恢复产物不是完整文件');
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) { bytes += chunk.length; hash.update(chunk); }
  const after = await stat(path);
  assert(bytes === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs, '恢复核验期间产物发生变化');
  return { bytes, sha256: hash.digest('hex') };
}

async function receiptFiles(dir, receipt, names) {
  assert.equal(receipt.schemaVersion, 1, '恢复回执版本无效');
  for (const name of names) {
    const expected = receipt.files?.[name];
    assert(expected && Number.isSafeInteger(expected.bytes) && expected.bytes > 0 && /^[a-f0-9]{64}$/.test(expected.sha256), '恢复回执缺少文件摘要');
    const actual = await fileFingerprint(join(dir, name));
    assert(actual.bytes === expected.bytes && actual.sha256 === expected.sha256, '恢复产物与回执不符');
  }
}

function sourceIdentity(metadata, bvid) {
  assert.equal(metadata.bvid, bvid, '源视频BV不匹配');
  assert(Number.isSafeInteger(metadata.uid) && metadata.uid > 0, '源视频作者身份缺失');
  assert.equal(metadata.source, `https://www.bilibili.com/video/${bvid}/`, '源视频地址不匹配');
  assert.equal(metadata.page, 1, '多P需单独核对');
}

function sameRunContext(candidate, reference, bvid) {
  if (!candidate || !Number.isSafeInteger(candidate.spaceId) || candidate.spaceId < 0 || !['page', 'targetId', 'expectedUrl', 'runId'].every(key => typeof candidate[key] === 'string' && candidate[key])) return false;
  if (reference && (candidate.runId !== reference.runId || candidate.spaceId !== reference.spaceId || candidate.page !== reference.page || candidate.targetId !== reference.targetId)) return false;
  try {
    const url = new URL(candidate.expectedUrl);
    return url.origin === 'https://www.bilibili.com' && url.pathname === `/video/${bvid}/` && [...url.searchParams.keys()].every(key => key === 'vd_source');
  } catch { return false; }
}

async function authenticatedContext(dir, reference, bvid) {
  try {
    const candidate = await readJSON(join(dir, 'browser-context.json'));
    return sameRunContext(candidate, reference, bvid) ? candidate : null;
  } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}

async function loadReceipt(dir, name, names, bvid) {
  try {
    const receipt = await readJSON(join(dir, name));
    await receiptFiles(dir, receipt, names);
    sourceIdentity(await readJSON(join(dir, 'metadata.json')), bvid);
    if (receipt.bvid !== undefined) assert.equal(receipt.bvid, bvid);
    return receipt;
  } catch (error) {
    if (error.code === 'EACCES' || error.code === 'EPERM') throw error;
    return null; // Untrusted leftovers are preserved before a new attempt.
  }
}

async function abandon(dir, names, reason) {
  const found = [];
  for (const name of names) {
    try { if ((await stat(join(dir, name))).isFile()) found.push(name); else throw new Error('未完成产物不是普通文件'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!found.length) return;
  const target = join(dir, 'abandoned', `${new Date().toISOString().replace(/[:.]/g, '-')}-${reason}-${randomUUID().slice(0, 8)}`);
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const name of found) await rename(join(dir, name), join(target, basename(name)));
}

async function reusablePlan(dir, metadata, skillDir) {
  let raw;
  try { raw = await readFile(join(dir, 'plan.json')); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  const transcriptBytes = await readFile(join(dir, 'transcript.json'));
  const transcript = JSON.parse(transcriptBytes);
  const source = validateInput(transcript, metadata).source;
  const expected = { planSha256: digest(raw), transcriptSha256: digest(transcriptBytes), sourceSha256: digest(JSON.stringify(source)) };
  let attempts;
  try { attempts = await readdir(join(dir, '.plan-attempts'), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  for (const attempt of attempts.filter(entry => entry.isDirectory())) {
    let report;
    try { report = await readJSON(join(dir, '.plan-attempts', attempt.name, 'report.json')); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) continue; throw error; }
    if (report.status !== 'completed' || report.authentication !== 'native-codex' || report.audit?.toolCalls !== 0 || report.audit?.turnCompleted !== true || !Object.entries(expected).every(([key, value]) => report[key] === value)) continue;
    const actualSkill = await realpath(skillDir);
    const { validatePlan } = await import(pathToFileURL(join(actualSkill, 'scripts/lib.mjs')).href);
    try { validatePlan(JSON.parse(raw), transcript.segments, source); return true; }
    catch { /* Preserve a formerly completed plan rejected by the current Skill. */ }
  }
  return false;
}

export function validateTranscript(transcript, duration) {
  assert(Array.isArray(transcript.segments) && transcript.segments.length >= 5, '字幕内容不足');
  const excluded = [], segments = [];
  let previous = -1;
  for (const segment of transcript.segments) {
    assert(/^s\d+$/.test(segment.id) && typeof segment.text === 'string' && segment.text.trim(), '字幕结构无效');
    assert(Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.start >= previous && segment.end > segment.start, '字幕时间轴无效');
    previous = segment.start;
    if (segment.end > duration + .25) { excluded.push({ id: segment.id, reason: '超出独立源时长，保留原转写但不用于卡片' }); continue; }
    segments.push({ ...segment, end: Math.min(segment.end, duration) });
  }
  assert(new Set(segments.map(s => s.id)).size === segments.length, '字幕ID重复');
  assert(segments.length >= 5 && segments.at(-1).end >= duration * .6, '字幕覆盖不足，停止自动制卡');
  return { transcript: { ...transcript, segments }, quality: { duration, segments: segments.length, excluded, accuracy: 'local-asr-unreviewed' } };
}

export async function processEpisode(config, { bvid, context, episodeDir, adoptPrepared = false, signal, emit = () => {}, runners = {} } = {}) {
  assert(BVID.test(bvid), '无效BV号');
  const statePath = join(config.dataRoot, 'jobs', bvid + '.json');
  let job;
  try { job = await readJSON(statePath); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    job = { schemaVersion: 2, bvid, dir: resolve(episodeDir || join(config.dataRoot, 'episodes', bvid, stamp)), statePath, status: 'queued', phases: {} };
    await writeJSON(statePath, job);
  }
  assert([1, 2].includes(job.schemaVersion), '任务版本不受支持，不能自动恢复');
  if (episodeDir) assert.equal(job.dir, resolve(episodeDir), '已有任务使用另一份素材，不覆盖');
  const dir = job.dir, planPath = join(dir, 'plan.json');
  await mkdir(dir, { recursive: true });
  if (!context && job.context) context = job.context;
  const execute = runners.run || run, acquire = runners.acquire || acquireEpisode;
  const plan = runners.plan || generatePlan, selection = runners.selection || selectFrames;
  const options = { signal, timeout: config.stageTimeoutMs || 45 * 60_000 };
  const skill = (command, extra = []) => execute(process.execPath, [join(config.videoCardsSkill, 'scripts/video-cards.mjs'), command, '--out', dir, ...extra], options);
  let acquisitionAttemptStarted = 0;
  const rememberContext = async (candidate, fresh = false) => {
    // A caller may have deliberately navigated to discovery since this episode
    // last ran. Cached receipts cannot replace that freshly observed context.
    if (context && !fresh) return;
    const authenticated = candidate && sameRunContext(candidate, context, bvid) ? candidate : await authenticatedContext(dir, context, bvid);
    if (authenticated) context = authenticated;
    if (context) job.context = context;
  };
  try {
    await checkpoint(job, 'source', [join(dir, 'metadata.json'), join(dir, 'source.mp4'), join(dir, 'media-check.json'), join(dir, 'source-receipt.json')], async () => {
      let media;
      if (episodeDir) {
        await stat(join(dir, 'source.mp4')); // Explicit adoption only; never guess an old local video.
        const metadata = await readJSON(join(dir, 'metadata.json'));
        sourceIdentity(metadata, bvid);
        media = await probeSource(dir, metadata, { ...options, ffprobe: config.ffprobe, run: execute });
      } else {
        const completed = await loadReceipt(dir, 'source-receipt.json', ['metadata.json', 'source.mp4', 'media-check.json'], bvid);
        if (completed) { await rememberContext(completed.context); return; }
        let acquisition = await loadReceipt(dir, 'acquisition.json', ['metadata.json', 'audio.m4s', 'video.m4s'], bvid);
        await rememberContext(acquisition?.context);
        if (!acquisition) {
          await abandon(dir, ['metadata.json', 'audio.m4s', 'video.m4s', 'source.mp4', 'media-check.json', 'source-receipt.json', 'acquisition.json', 'media-fetch.json'], 'incomplete-acquisition');
          acquisitionAttemptStarted = Date.now();
          const result = await acquire(context, bvid, dir, { ...options, egoBin: config.egoBin, happyCapture: config.happyCapture });
          await rememberContext(result.context, true);
          if (result.browserStep) emit({ status: 'browser-step', ...result.browserStep });
          acquisition = await loadReceipt(dir, 'acquisition.json', ['metadata.json', 'audio.m4s', 'video.m4s'], bvid);
          assert(acquisition, '新采集媒体没有可核验的完成回执');
        }
        const metadata = await readJSON(join(dir, 'metadata.json'));
        sourceIdentity(metadata, bvid);
        const pending = join(dir, 'source-pending-' + randomUUID() + '.mp4');
        try {
          await execute(config.ffmpeg || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n', '-i', join(dir, 'video.m4s'), '-i', join(dir, 'audio.m4s'), '-map', '0:v', '-map', '1:a', '-c', 'copy', pending], options);
          media = await probeSource(dir, metadata, { ...options, ffprobe: config.ffprobe, sourcePath: pending, run: execute });
          if (signal?.aborted) throw signal.reason || new Error('操作已取消');
          await abandon(dir, ['source.mp4', 'media-check.json', 'source-receipt.json'], 'source-before-recovery');
          await rename(pending, join(dir, 'source.mp4'));
        } catch (error) { await abandon(dir, [basename(pending)], 'invalid-source-attempt'); throw error; }
      }
      await writeJSON(join(dir, 'media-check.json'), media);
      const files = {};
      for (const name of ['metadata.json', 'source.mp4', 'media-check.json']) files[name] = await fileFingerprint(join(dir, name));
      await writeJSON(join(dir, 'source-receipt.json'), { schemaVersion: 1, bvid, ...(context ? { context } : {}), files });
    }, emit);
    // Source reuse keeps both the existing artifacts and caller browser context.
    const metadata = await readJSON(join(dir, 'metadata.json'));
    const media = await readJSON(join(dir, 'media-check.json'));
    // v1 jobs retain their immutable legacy transcript and existing downstream
    // plans. New jobs keep ASR evidence separate from the corrected transcript.
    const asrName = job.schemaVersion === 2 ? 'transcript-asr.json' : 'transcript.json';
    const qualityName = job.schemaVersion === 2 ? 'transcript-asr-quality.json' : 'transcript-quality.json';
    await checkpoint(job, 'transcript', ['source.json', 'transcript-original.json', asrName, qualityName].map(name => join(dir, name)), async () => {
      // MLX Whisper has its own existing environment; Pillow is kept in a separate venv.
      if (adoptPrepared) {
        assert(episodeDir, '接入已转写资料必须显式指定目录');
        const source = await readJSON(join(dir, 'source.json'));
        assert.equal(source.url, metadata.source); assert.equal(source.title, metadata.title);
        await stat(join(dir, 'transcript-original.json'));
      } else await skill('prepare', ['--input', join(dir, 'source.mp4'), '--python', config.whisperPython, '--model', config.whisperModel || 'mlx-community/whisper-large-v3-turbo', '--title', metadata.title, '--author', metadata.author, '--url', metadata.source]);
      const checked = validateTranscript(await readJSON(join(dir, 'transcript.json')), media.duration);
      await writeJSON(join(dir, asrName), checked.transcript);
      await writeJSON(join(dir, qualityName), checked.quality);
    }, emit);
    if (job.schemaVersion === 2) await checkpoint(job, 'proofread', async () => {
      const report = await readJSON(join(dir, 'transcript-proofread.json'));
      const evidence = Object.keys(report.evidence);
      assert(evidence.every(name => /^subtitle-proofread\/(?:s\d+-[0-2]\.jpg|frames\.json|observations\.json|verify-\d+(?:\.schema)?\.json)$/.test(name)), '字幕核对证据路径无效');
      return [...['transcript.json', 'transcript-quality.json', 'transcript-proofread.json', 'transcript.srt', 'transcript.md'], ...evidence].map(name => join(dir, name));
    }, async () => (runners.proofread || proofreadTranscript)(config, { dir,
      transcript: await readJSON(join(dir, asrName)), quality: await readJSON(join(dir, qualityName)), signal, execute }), emit);
    await checkpoint(job, 'plan', [planPath], async () => {
      const normalized = validateInput(await readJSON(join(dir, 'transcript.json')), { ...metadata, duration: media.duration }).source;
      if (await reusablePlan(dir, normalized, config.videoCardsSkill)) return;
      await abandon(dir, ['plan.json'], 'unverified-plan');
      await plan({ transcriptPath: join(dir, 'transcript.json'), metadata: normalized, outDir: dir, codexBin: config.codexBin, skillDir: config.videoCardsSkill, signal });
    }, emit);
    await checkpoint(job, 'frames', async () => {
      const frames = await readJSON(join(dir, 'frames-original.json'));
      return [join(dir, 'frames-original.json'), ...frames.flatMap(f => f.candidates.map(c => join(dir, c.file)))];
    }, async () => {
      await skill('validate', ['--plan', planPath]);
      await skill('frames', ['--plan', planPath]);
      await copyFile(join(dir, 'frames.json'), join(dir, 'frames-original.json'));
    }, emit);
    await checkpoint(job, 'selection', [join(dir, 'frames.json'), join(dir, 'selection-report.json')], () => selection({ outDir: dir, codexBin: config.codexBin, skillDir: config.videoCardsSkill, signal }), emit);
    await checkpoint(job, 'cards', async () => [join(dir, 'cards.json'), ...((await readJSON(join(dir, 'cards.json'))).map(c => join(dir, c.file)))], () => skill('render', ['--plan', planPath, '--python', config.renderPython, '--font', config.font, '--max-height', '12000']), emit);
    if (config.imageOpsScript) await checkpoint(job, 'archive', [join(dir, 'image-ops-archive.json')], () => archiveCards({ outDir: dir, imageOpsScript: config.imageOpsScript, font: config.font, signal, emit }), emit);
    job.status = 'ready'; job.phase = 'cards'; await writeJSON(statePath, job); emit({ bvid, status: 'ready', phase: 'cards' });
    return { job, context, metadata };
  } catch (error) {
    if (acquisitionAttemptStarted) {
      await (async () => {
        if ((await stat(join(dir, 'browser-context.json'))).mtimeMs >= acquisitionAttemptStarted)
          await rememberContext(null, true);
      })().catch(() => {});
    }
    job.status = 'failed'; job.error = safeError(error); await writeJSON(statePath, job); emit({ bvid, phase: job.phase, status: 'failed', error: job.error });
    throw error;
  }
}
