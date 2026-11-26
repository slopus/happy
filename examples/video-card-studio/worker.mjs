/** Fixed locally registered workflow. Visitors supply only a persisted job ID, never code or callback locations. */
import { readFile, mkdir, writeFile, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processEpisode } from './pipeline/episode.mjs';
import { openBrowser, acquireEpisode, finishBrowser } from './pipeline/bilibili.mjs';
import { readJSON, writeJSON, safeError } from './pipeline/io.mjs';
import { uuid, normalizeVideo } from './store.mjs';
import { readCredential, secureOrigin } from './credentials.mjs';

export async function runCardJob(config, input, { token, signal } = {}) {
  uuid(input.taskId); uuid(input.runId);
  if (input.taskId !== config.taskId || !input.input || Object.keys(input.input).length !== 1) throw new Error('Task identity mismatch');
  const jobId = uuid(input.input.jobId), origin = secureOrigin(config.siteOrigin);
  token ??= await readCredential(config.workerCredential);
  const dir = join(resolve(config.dataRoot), jobId); await mkdir(dir, { recursive: true, mode: 0o700 });
  // Exclusive intent survives a crash. The operator must inspect this job before
  // explicitly recovering it; another delivery cannot silently repeat media/model work.
  const intent = await open(join(dir, 'execution.json'), 'wx', 0o600);
  await intent.writeFile(JSON.stringify({ taskId: input.taskId, runId: input.runId, startedAt: Date.now() })); await intent.sync(); await intent.close();
  const api = async (action, value, { bytes, name } = {}) => {
    const response = await fetch(`${origin}/internal/jobs/${jobId}/${name ? 'artifacts/' + name : action}`, { method: name ? 'PUT' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': name ? 'image/png' : 'application/json', ...(name ? { 'x-run-id': input.runId } : {}) },
      body: bytes ?? JSON.stringify({ runId: input.runId, ...value }), signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60000)]) });
    if (!response.ok) throw new Error(`Website operation failed (${response.status})`);
    return response.json();
  };
  let context, events = [], uploads = Promise.resolve(), uploadError;
  try {
    const { job } = await api('start', {}), video = normalizeVideo(job.url);
    if (job.id !== jobId || job.bvid !== video.bvid) throw new Error('Job identity mismatch');
    context = config.browserContextPath ? await readJSON(config.browserContextPath) : await openBrowser({ runId: `cards-${input.runId}`, signal });
    await writeJSON(join(dir, 'browser-context.json'), context);
    const emit = event => {
      events.push({ ...event, at: Date.now() });
      // The complete private record is local. Only fixed phase names go to visitors.
      uploads = uploads.then(async () => {
        await writeJSON(join(dir, 'events.json'), events);
        if (event.phase && event.status === 'running') await api('progress', { phase: event.phase });
      }).catch(error => { uploadError ??= error; });
    };
    const pipeline = { ...config.runtime, dataRoot: dir, videoCardsSkill: fileURLToPath(new URL('./pipeline/render', import.meta.url)), happyCapture: config.happyCapture };
    const result = await processEpisode(pipeline, { bvid: video.bvid, context, signal, emit, runners: {
      acquire: async (...args) => {
        const acquired = await acquireEpisode(...args); context = acquired.context;
        // Persist the verified navigation before later model/quality stages.
        // A later failure must not leave a stale URL in the next job's context.
        await writeJSON(join(dir, 'browser-context.json'), context);
        if (config.browserContextPath) await writeJSON(config.browserContextPath, context);
        else if (!config.retainBrowserForVerification) await finishBrowser(context, { signal });
        return acquired;
      },
    } }); context = result.context;
    await writeJSON(join(dir, 'browser-context.json'), context);
    if (config.browserContextPath) await writeJSON(config.browserContextPath, context);
    await uploads; if (uploadError) throw uploadError;
    await api('progress', { phase: 'upload' });
    const out = result.job.dir;
    const [cards, plan, transcript] = await Promise.all(['cards.json', 'plan.json', 'transcript.json'].map(name => readJSON(join(out, name))));
    const manifest = { title: result.metadata.title, author: result.metadata.author, source: video.url, cards: [] };
    for (const [index, card] of cards.entries()) {
      if (card.file !== `cards/${card.card}.png` || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(card.card)) throw new Error('Invalid card output');
      const selection = plan.cards.find(row => row.id === card.card), segments = new Map(transcript.segments.map(row => [row.id, row]));
      const evidence = selection.blocks.flatMap(block => block.evidence.map(id => ({ ...segments.get(id), text: block.excerpts?.[id] ?? segments.get(id).text })));
      const name = `card-${String(index + 1).padStart(3, '0')}.png`, bytes = await readFile(join(out, card.file));
      const receipt = await api(null, null, { bytes, name });
      manifest.cards.push({ file: name, sha256: receipt.sha256, quote: evidence.map(row => row.text).join('\n'), start: evidence[0].start, end: evidence.at(-1).end });
    }
    await writeJSON(join(dir, 'manifest.json'), manifest);
    await api('complete', { manifest });
    await writeJSON(join(dir, 'result.json'), { status: 'completed', jobId, runId: input.runId, cards: manifest.cards.length, outDir: out, context });
    // A supplied context belongs to the operator. Auto-created successful
    // acquisition spaces are finished above; failures preserve the exact space
    // for diagnosis, with no new-space recovery.
    return { jobId, cards: manifest.cards.length, outDir: out, context };
  } catch (error) {
    await uploads;
    await writeJSON(join(dir, 'result.json'), { status: 'failed', jobId, runId: input.runId, error: safeError(error), context });
    await api('fail', {}).catch(() => {});
    throw error;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(await readFile(process.argv[2], 'utf8')); let raw = '';
  for await (const bytes of process.stdin) { raw += bytes; if (Buffer.byteLength(raw) > 16384) throw new Error('Input too large'); }
  const controller = new AbortController(); process.once('SIGTERM', () => controller.abort()); process.once('SIGINT', () => controller.abort());
  try { await runCardJob(config, JSON.parse(raw), { signal: controller.signal }); }
  catch { process.exitCode = 1; }
}
