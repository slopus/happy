/**
 * Atomic Slot Allocation System
 *
 * This module provides atomic slot allocation for parallel E2E test execution.
 * Each test worker can claim a slot (1-N) which provides isolated ports and directories.
 *
 * Slot allocation uses atomic file operations:
 * - To claim: atomically rename an "available" marker file to "claimed-{pid}"
 * - To release: remove the claimed file
 *
 * Slot 0 is reserved for production, so test slots start at 1.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync, spawn, ChildProcess } from 'node:child_process';

// Slot configuration matching happy-launcher.sh
const SLOT_DIR = '/tmp/happy-slots';
const MAX_SLOTS = 10; // Maximum parallel test instances
const MIN_SLOT = 1;   // Slot 0 is reserved for production

// Port configuration matching happy-launcher.sh
const BASE_SERVER_PORT = 10001;
const BASE_WEBAPP_PORT = 10002;
const BASE_MINIO_PORT = 10003;
const BASE_MINIO_CONSOLE_PORT = 10004;
const BASE_METRICS_PORT = 10005;
const SLOT_OFFSET = 10;

export interface SlotConfig {
    slot: number;
    serverPort: number;
    webappPort: number;
    minioPort: number;
    minioConsolePort: number;
    metricsPort: number;
    serverUrl: string;
    webappUrl: string;
    homeDir: string;
    logDir: string;
    pidsDir: string;
}

export interface SlotHandle {
    config: SlotConfig;
    release: () => void;
}

/**
 * Calculate port configuration for a given slot number
 */
export function getSlotConfig(slot: number): SlotConfig {
    const offset = (slot - 1) * SLOT_OFFSET;
    const serverPort = BASE_SERVER_PORT + offset;
    const webappPort = BASE_WEBAPP_PORT + offset;
    const minioPort = BASE_MINIO_PORT + offset;
    const minioConsolePort = BASE_MINIO_CONSOLE_PORT + offset;
    const metricsPort = BASE_METRICS_PORT + offset;

    return {
        slot,
        serverPort,
        webappPort,
        minioPort,
        minioConsolePort,
        metricsPort,
        serverUrl: `http://localhost:${serverPort}`,
        webappUrl: `http://localhost:${webappPort}`,
        homeDir: `/tmp/.happy-e2e-slot-${slot}`,
        logDir: `/tmp/happy-slot-${slot}`,
        pidsDir: path.join(process.cwd(), '..', '..', `.pids-slot-${slot}`),
    };
}

/**
 * Initialize the slot directory structure
 */
function initSlotDirectory(): void {
    if (!fs.existsSync(SLOT_DIR)) {
        fs.mkdirSync(SLOT_DIR, { recursive: true });
    }

    // Create "available" marker files for each slot if they don't exist
    for (let slot = MIN_SLOT; slot <= MAX_SLOTS; slot++) {
        const availableFile = path.join(SLOT_DIR, `slot-${slot}-available`);
        const claimedPattern = path.join(SLOT_DIR, `slot-${slot}-claimed-*`);

        // Check if slot is already claimed
        const files = fs.readdirSync(SLOT_DIR);
        const isClaimed = files.some(f => f.startsWith(`slot-${slot}-claimed-`));

        if (!isClaimed && !fs.existsSync(availableFile)) {
            // Create available marker
            fs.writeFileSync(availableFile, `${Date.now()}`);
        }
    }
}

/**
 * Atomically claim a slot by renaming the available marker file
 * Returns the slot number if successful, null if no slots available
 */
export function claimSlot(): SlotHandle | null {
    initSlotDirectory();

    const pid = process.pid;

    for (let slot = MIN_SLOT; slot <= MAX_SLOTS; slot++) {
        const availableFile = path.join(SLOT_DIR, `slot-${slot}-available`);
        const claimedFile = path.join(SLOT_DIR, `slot-${slot}-claimed-${pid}`);

        try {
            // Atomic rename - if this succeeds, we own the slot
            fs.renameSync(availableFile, claimedFile);

            const config = getSlotConfig(slot);

            // Ensure directories exist
            fs.mkdirSync(config.homeDir, { recursive: true });
            fs.mkdirSync(config.logDir, { recursive: true });

            const release = () => releaseSlot(slot, pid);

            // Register cleanup on process exit
            process.once('exit', release);
            process.once('SIGINT', () => {
                release();
                process.exit(130);
            });
            process.once('SIGTERM', () => {
                release();
                process.exit(143);
            });

            return { config, release };
        } catch (err) {
            // Rename failed - slot was already claimed or doesn't exist
            continue;
        }
    }

    return null;
}

/**
 * Release a claimed slot
 */
export function releaseSlot(slot: number, pid: number = process.pid): void {
    const claimedFile = path.join(SLOT_DIR, `slot-${slot}-claimed-${pid}`);
    const availableFile = path.join(SLOT_DIR, `slot-${slot}-available`);

    try {
        // Remove claimed file and create available marker
        if (fs.existsSync(claimedFile)) {
            fs.unlinkSync(claimedFile);
        }
        fs.writeFileSync(availableFile, `${Date.now()}`);
    } catch (err) {
        // Best effort cleanup
        console.error(`Failed to release slot ${slot}:`, err);
    }
}

/**
 * Clean up stale slot claims (from crashed processes)
 */
export function cleanupStaleSlots(): void {
    initSlotDirectory();

    const files = fs.readdirSync(SLOT_DIR);

    for (const file of files) {
        const match = file.match(/^slot-(\d+)-claimed-(\d+)$/);
        if (match) {
            const slot = parseInt(match[1], 10);
            const pid = parseInt(match[2], 10);

            // Check if process is still running
            try {
                process.kill(pid, 0); // Doesn't kill, just checks if process exists
            } catch {
                // Process doesn't exist, release the slot
                console.log(`Cleaning up stale slot ${slot} (PID ${pid} no longer running)`);
                releaseSlot(slot, pid);
            }
        }
    }
}

/**
 * Get list of currently claimed slots
 */
export function getClaimedSlots(): Array<{ slot: number; pid: number }> {
    initSlotDirectory();

    const files = fs.readdirSync(SLOT_DIR);
    const claimed: Array<{ slot: number; pid: number }> = [];

    for (const file of files) {
        const match = file.match(/^slot-(\d+)-claimed-(\d+)$/);
        if (match) {
            claimed.push({
                slot: parseInt(match[1], 10),
                pid: parseInt(match[2], 10),
            });
        }
    }

    return claimed.sort((a, b) => a.slot - b.slot);
}

/**
 * Get list of available slots
 */
export function getAvailableSlots(): number[] {
    initSlotDirectory();

    const files = fs.readdirSync(SLOT_DIR);
    const available: number[] = [];

    for (const file of files) {
        const match = file.match(/^slot-(\d+)-available$/);
        if (match) {
            available.push(parseInt(match[1], 10));
        }
    }

    return available.sort((a, b) => a - b);
}
