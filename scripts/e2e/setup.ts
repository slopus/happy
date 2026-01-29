/**
 * Global E2E Test Setup
 *
 * This file handles global setup and teardown for E2E tests.
 * It ensures slots are cleaned up from previous crashed runs.
 */

import { cleanupStaleSlots, getClaimedSlots, getAvailableSlots } from './helpers/slots.js';

export async function setup(): Promise<void> {
    console.log('\n=== E2E Test Setup ===\n');

    // Clean up any stale slots from crashed processes
    cleanupStaleSlots();

    // Report slot status
    const claimed = getClaimedSlots();
    const available = getAvailableSlots();

    console.log(`Available slots: ${available.length}`);
    console.log(`Claimed slots: ${claimed.length}`);

    if (claimed.length > 0) {
        console.log('Currently claimed:');
        claimed.forEach(s => console.log(`  Slot ${s.slot} by PID ${s.pid}`));
    }

    console.log('\n');
}

export async function teardown(): Promise<void> {
    console.log('\n=== E2E Test Teardown ===\n');

    // Report final slot status
    const claimed = getClaimedSlots();
    const available = getAvailableSlots();

    console.log(`Final available slots: ${available.length}`);
    console.log(`Final claimed slots: ${claimed.length}`);

    if (claimed.length > 0) {
        console.log('WARNING: Some slots were not released:');
        claimed.forEach(s => console.log(`  Slot ${s.slot} by PID ${s.pid}`));
    }

    console.log('\n');
}
