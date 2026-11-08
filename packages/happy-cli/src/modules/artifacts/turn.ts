import { randomUUID } from 'node:crypto';
import { ArtifactRefSchema } from '@slopus/happy-wire';
import type { ArtifactRef } from '@slopus/happy-wire';
import type { ArtifactStore } from './store';
/** The runner must await this BEFORE handing control to Codex, then await durable terminal capture. */
export async function runArtifactTurn<T extends { aborted: boolean }>(store: ArtifactStore, input: { directory: string; sessionId: string; prompt: string; runId?: string; writerPids?: number[] }, run: () => Promise<T>): Promise<T> {
  const runId = input.runId ?? randomUUID();
  let prompt = input.prompt;
  let expected: (ArtifactRef & { expectedRevision: string }) | undefined;
  let reference: { path: string; hash: string } | undefined;
  const marker = '\n\n[Workspace file context]\n';
  const boundary = prompt.lastIndexOf(marker);
  if (boundary !== -1) {
    try {
      const candidate = JSON.parse(prompt.slice(boundary + marker.length).split('\n')[0]);
      if (typeof candidate.path === 'string' && candidate.path.length <= 8192 && typeof candidate.hash === 'string' && /^[a-f0-9]{64}$/.test(candidate.hash)) {
        reference = { path: candidate.path, hash: candidate.hash };
        if (candidate.artifact && ArtifactRefSchema.safeParse(candidate.artifact).success && /^[a-f0-9]{64}$/.test(candidate.artifact.expectedRevision)) expected = {workspaceId:candidate.artifact.workspaceId,artifactId:candidate.artifact.artifactId,expectedRevision:candidate.artifact.expectedRevision};
        prompt = prompt.slice(0, boundary);
      }
    } catch { /* A literal marker in ordinary user prose is not a file binding. */ }
  }
  await store.beginTurn({ ...input, prompt, runId, reference, expected });
  let status: 'completed' | 'cancelled' | 'failed' = 'failed';
  try { const result = await run(); status = result.aborted ? 'cancelled' : 'completed'; return result; }
  finally { await store.finishTurn(runId, status); }
}

/** Shared/attached native clients can execute outside this worker; do not advertise their scope as leased. */
export async function prepareCodexArtifactScope(mode: { connection: 'spawn' | 'unixSocket'; attached: boolean }, guardUnmanaged: () => Promise<void>) {
  const supported = (process.platform === 'darwin' || process.platform === 'linux') && mode.connection === 'spawn' && !mode.attached;
  if (!supported) await guardUnmanaged();
  return supported;
}
