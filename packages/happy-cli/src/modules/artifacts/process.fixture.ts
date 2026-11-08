// Test subprocess: real, independent Node process sharing only the durable store.
import { ArtifactStore } from './store';
const options = JSON.parse(process.argv[2]);
const store = new ArtifactStore({ storage: options.storage, accountScope: 'a'.repeat(64), inventory: async () => [] });
try {
  if (options.action === 'lease') {
    await store.beginTurn({ directory: options.root, sessionId: 'child', runId: 'child-run', prompt: 'child write', writerPids: options.writerPids });
    if (options.trackPid) await store.trackWriterProcess('child-run', options.trackPid);
    process.stdout.write('LEASED\n');
    process.stdin.once('data', async () => {
      try { await store.finishTurn('child-run', 'completed'); }
      catch (error) { if (!options.allowPending || (error as { code?: string }).code !== 'COMMIT_PENDING') throw error; }
      process.exit(0);
    });
    process.stdin.resume();
  } else {
    const value = options.action === 'restore' ? await store.restore(options.request) : await store.save(options.request);
    process.stdout.write(JSON.stringify({ ok: true, value }) + '\n');
  }
} catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: (error as any).code, message: (error as Error).message }) + '\n'); }
