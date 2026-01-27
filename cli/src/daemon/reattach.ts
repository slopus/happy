import { ALLOWED_HAPPY_SESSION_PROCESS_TYPES } from './pidSafety';
import type { HappyProcessInfo } from './doctor';
import type { DaemonSessionMarker } from './sessionRegistry';
import { hashProcessCommand } from './sessionRegistry';
import type { TrackedSession } from './types';

export function adoptSessionsFromMarkers(params: {
  markers: DaemonSessionMarker[];
  happyProcesses: HappyProcessInfo[];
  pidToTrackedSession: Map<number, TrackedSession>;
}): { adopted: number; eligible: number } {
  const happyPidToType = new Map(params.happyProcesses.map((p) => [p.pid, p.type] as const));
  const happyPidToCommandHash = new Map(params.happyProcesses.map((p) => [p.pid, hashProcessCommand(p.command)] as const));

  let adopted = 0;
  let eligible = 0;

  for (const marker of params.markers) {
    // Safety: avoid PID reuse adopting an unrelated process. Only adopt if PID currently looks
    // like a Happy session process (best-effort cross-platform via ps-list classification).
    const procType = happyPidToType.get(marker.pid);
    if (!procType || !ALLOWED_HAPPY_SESSION_PROCESS_TYPES.has(procType)) {
      continue;
    }
    eligible++;

    // Stronger PID reuse safety: require the marker's observed command hash to match what is currently running.
    if (!marker.processCommandHash) {
      continue;
    }
    const currentHash = happyPidToCommandHash.get(marker.pid);
    if (!currentHash || currentHash !== marker.processCommandHash) {
      continue;
    }

    if (params.pidToTrackedSession.has(marker.pid)) continue;
    params.pidToTrackedSession.set(marker.pid, {
      startedBy: marker.startedBy ?? 'reattached',
      happySessionId: marker.happySessionId,
      happySessionMetadataFromLocalWebhook: marker.metadata,
      pid: marker.pid,
      processCommandHash: marker.processCommandHash,
      reattachedFromDiskMarker: true,
    });
    adopted++;
  }

  return { adopted, eligible };
}
