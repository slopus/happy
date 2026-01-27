import { logger } from '@/ui/logger';

import type { TrackedSession } from '../types';
import { findAllHappyProcesses } from '../doctor';
import { adoptSessionsFromMarkers } from '../reattach';
import { listSessionMarkers, removeSessionMarker } from '../sessionRegistry';

export async function reattachTrackedSessionsFromMarkers(params: Readonly<{
  pidToTrackedSession: Map<number, TrackedSession>;
}>): Promise<void> {
  const { pidToTrackedSession } = params;

  // On daemon restart, reattach to still-running sessions via disk markers (stack-scoped by HAPPY_HOME_DIR).
  try {
    const markers = await listSessionMarkers();
    const happyProcesses = await findAllHappyProcesses();
    const aliveMarkers = [];
    for (const marker of markers) {
      try {
        process.kill(marker.pid, 0);
        aliveMarkers.push(marker);
      } catch {
        await removeSessionMarker(marker.pid);
        continue;
      }
    }
    const { adopted } = adoptSessionsFromMarkers({ markers: aliveMarkers, happyProcesses, pidToTrackedSession });
    if (adopted > 0) logger.debug(`[DAEMON RUN] Reattached ${adopted} sessions from disk markers`);
  } catch (e) {
    logger.debug('[DAEMON RUN] Failed to reattach sessions from disk markers', e);
  }
}
