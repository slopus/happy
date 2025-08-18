import type { Machine } from '@/sync/storageTypes';

// Heartbeat is sent every 20 seconds, so 2x that is 40 seconds
const MACHINE_ONLINE_THRESHOLD = 40 * 1000; // 40 seconds in milliseconds

export function isMachineOnline(machine: Machine): boolean {
    if (!machine.activeAt) {
        return false;
    }
    
    const timeSinceLastActive = Date.now() - machine.activeAt;
    return timeSinceLastActive < MACHINE_ONLINE_THRESHOLD;
}