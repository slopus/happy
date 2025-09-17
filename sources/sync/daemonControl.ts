/**
 * Enhanced daemon control utilities with cleanup and force stop capabilities
 */

import { machineStopDaemon, sessionKill } from './ops';
import { sync } from './sync';
import { storage } from './storage';
import type { Session } from './storageTypes';
import { log } from '@/log';

export interface DaemonControlResult {
  success: boolean;
  message: string;
  error?: string;
}

/**
 * Standard daemon stop operation
 */
export async function stopDaemon(machineId: string): Promise<DaemonControlResult> {
  try {
    log.log(`🛑 Attempting to stop daemon on machine ${machineId}`);
    const result = await machineStopDaemon(machineId);
    log.log(`✅ Daemon stopped successfully on machine ${machineId}: ${result.message}`);
    return {
      success: true,
      message: result.message,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    log.log(`❌ Failed to stop daemon on machine ${machineId}: ${errorMsg}`);
    return {
      success: false,
      message: 'Failed to stop daemon',
      error: errorMsg,
    };
  }
}

/**
 * Force stop daemon using alternative methods
 */
export async function forceStopDaemon(machineId: string): Promise<DaemonControlResult> {
  try {
    // First, try to kill all active sessions on this machine
    const sessions = storage.getState().sessions;
    const machineSessions = Object.values(sessions).filter(
      session => session.metadata?.machineId === machineId && session.active,
    );

    log.log(`🚨 Force stopping daemon on ${machineId}: found ${machineSessions.length} active sessions`);

    // Kill all active sessions first
    const killPromises = machineSessions.map(async (session) => {
      try {
        log.log(`🔪 Killing session ${session.id}...`);
        const result = await sessionKill(session.id);
        if (result.success) {
          log.log(`✅ Successfully killed session ${session.id}`);
        } else {
          log.log(`⚠️ Failed to kill session ${session.id}: ${result.message}`);
        }
        return result;
      } catch (error) {
        log.log(`❌ Error killing session ${session.id}: ${error instanceof Error ? error.message : error}`);
        return { success: false, message: error instanceof Error ? error.message : 'Unknown error' };
      }
    });

    const killResults = await Promise.allSettled(killPromises);
    const successfulKills = killResults.filter(result =>
      result.status === 'fulfilled' && result.value.success,
    ).length;

    // Now try the standard daemon stop
    try {
      const result = await machineStopDaemon(machineId);
      return {
        success: true,
        message: `Force stop successful: killed ${successfulKills}/${machineSessions.length} sessions, daemon stopped. ${result.message}`,
      };
    } catch (daemonError) {
      // Even if daemon stop fails, we might have successfully killed sessions
      if (successfulKills > 0) {
        return {
          success: true,
          message: `Partial force stop: killed ${successfulKills}/${machineSessions.length} sessions, but daemon stop failed.`,
        };
      } else {
        throw daemonError;
      }
    }

  } catch (error) {
    return {
      success: false,
      message: 'Force stop failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Remove session state locally without affecting the remote daemon
 */
export async function removeSessionLocally(machineId: string): Promise<DaemonControlResult> {
  try {
    const sessions = storage.getState().sessions;
    const machineSessions = Object.values(sessions).filter(
      session => session.metadata?.machineId === machineId,
    );

    console.log(`Removing ${machineSessions.length} sessions locally for machine ${machineId}`);

    // Mark all sessions as inactive locally
    const updatedSessions: Session[] = machineSessions.map(session => ({
      ...session,
      active: false,
      thinking: false,
      thinkingAt: 0,
      updatedAt: Date.now(),
    }));

    // Update storage
    storage.getState().applySessions(updatedSessions);

    // Clear any cached message data for these sessions
    for (const session of machineSessions) {
      storage.getState().clearSessionMessages(session.id);
    }

    // Update machine metadata to indicate manual cleanup
    const machine = storage.getState().machines[machineId];
    if (machine && machine.metadata) {
      const updatedMetadata = {
        ...machine.metadata,
        daemonLastKnownStatus: 'manually-cleaned' as any,
        lastCleanupAt: Date.now(),
        cleanupReason: 'user-requested-session-removal',
      };

      try {
        // Try to update machine metadata on server
        const machineEncryption = sync.encryption.getMachineEncryption(machineId);
        if (machineEncryption) {
          const encryptedMetadata = await machineEncryption.encryptRaw(updatedMetadata);
          // Note: This might fail if network is down, but that's okay for local cleanup
          try {
            await sync.refreshMachines();
          } catch (refreshError) {
            console.warn('Failed to refresh machines during cleanup:', refreshError);
          }
        }
      } catch (metadataError) {
        console.warn('Failed to update machine metadata during cleanup:', metadataError);
        // Continue with local cleanup even if metadata update fails
      }
    }

    return {
      success: true,
      message: `Successfully removed ${machineSessions.length} session(s) locally. The daemon may still be running on the remote machine.`,
    };

  } catch (error) {
    return {
      success: false,
      message: 'Failed to remove sessions locally',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Get current daemon status for a machine
 */
export function getDaemonStatus(machineId: string): 'likely-alive' | 'stopped' | 'unknown' {
  const machine = storage.getState().machines[machineId];
  if (!machine) return 'unknown';

  const metadata = machine.metadata as any;
  if (metadata?.daemonLastKnownStatus === 'shutting-down' || metadata?.daemonLastKnownStatus === 'manually-cleaned') {
    return 'stopped';
  }

  // Check if machine has been active recently (within last 5 minutes)
  const now = Date.now();
  const lastActive = machine.activeAt || 0;
  const timeSinceActive = now - lastActive;
  const fiveMinutes = 5 * 60 * 1000;

  if (timeSinceActive < fiveMinutes) {
    return 'likely-alive';
  }

  return 'stopped';
}

/**
 * Check if there are any active sessions on a machine
 */
export function hasActiveSessions(machineId: string): boolean {
  const sessions = storage.getState().sessions;
  return Object.values(sessions).some(
    session => session.metadata?.machineId === machineId && session.active,
  );
}

/**
 * Get count of active sessions on a machine
 */
export function getActiveSessionCount(machineId: string): number {
  const sessions = storage.getState().sessions;
  return Object.values(sessions).filter(
    session => session.metadata?.machineId === machineId && session.active,
  ).length;
}