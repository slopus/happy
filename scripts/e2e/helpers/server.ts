/**
 * Server Helper - Manages happy-server and related services for E2E tests
 *
 * This module provides functions to start/stop the server stack using
 * the happy-launcher.sh script with slot-based isolation.
 */

import { execSync, spawn, ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { SlotConfig, SlotHandle, claimSlot, releaseSlot, cleanupStaleSlots } from './slots.js';

const ROOT_DIR = path.resolve(import.meta.dirname, '..', '..', '..');
const LAUNCHER_PATH = path.join(ROOT_DIR, 'happy-launcher.sh');

export interface ServerHandle {
    slot: SlotHandle;
    stop: () => Promise<void>;
}

/**
 * Wait for a port to become available
 */
async function waitForPort(port: number, timeoutMs: number = 30000): Promise<boolean> {
    const start = Date.now();
    const checkInterval = 500;

    while (Date.now() - start < timeoutMs) {
        try {
            const response = await fetch(`http://localhost:${port}/`, {
                method: 'GET',
                signal: AbortSignal.timeout(1000),
            });
            if (response.ok || response.status < 500) {
                return true;
            }
        } catch {
            // Port not ready yet
        }
        await new Promise(resolve => setTimeout(resolve, checkInterval));
    }
    return false;
}

/**
 * Wait for webapp to be fully ready (bundle compiled, not just port open)
 * Metro bundler can respond quickly but the bundle takes time to compile
 *
 * We check the actual JavaScript bundle endpoint, not just the HTML shell,
 * because the HTML returns immediately but the JS bundle takes time to compile.
 */
async function waitForWebappReady(port: number, timeoutMs: number = 180000): Promise<boolean> {
    const start = Date.now();
    const checkInterval = 3000;

    // The bundle URL that Metro serves - this is what takes time to compile
    const bundleUrl = `http://localhost:${port}/index.ts.bundle?platform=web&dev=true&hot=false&lazy=true`;

    console.log(`[E2E] Waiting for webapp bundle to compile (this may take 1-2 minutes)...`);

    while (Date.now() - start < timeoutMs) {
        try {
            const response = await fetch(bundleUrl, {
                method: 'GET',
                signal: AbortSignal.timeout(30000), // Bundle can take a while
            });

            const contentType = response.headers.get('content-type') || '';

            // If we get JavaScript content type, the bundle is ready
            if (
                contentType.includes('application/javascript') ||
                contentType.includes('text/javascript')
            ) {
                console.log(`[E2E] Bundle compiled successfully`);
                return true;
            }

            // If we get JSON, Metro is returning an error or status
            if (contentType.includes('application/json')) {
                const text = await response.text();
                try {
                    const json = JSON.parse(text);
                    if (json.errors) {
                        console.log(`[E2E] Metro bundler errors:`, json.errors);
                    } else if (json.message) {
                        console.log(`[E2E] Metro bundler status: ${json.message}`);
                    }
                } catch {
                    // Ignore JSON parse errors
                }
            }
        } catch (err) {
            // Connection error or timeout - bundler still working
            const elapsed = Math.round((Date.now() - start) / 1000);
            console.log(`[E2E] Waiting for bundle... (${elapsed}s elapsed)`);
        }
        await new Promise(resolve => setTimeout(resolve, checkInterval));
    }
    return false;
}

/**
 * Start all services on an available slot
 * Returns the slot configuration and a function to stop services
 */
export async function startServices(): Promise<ServerHandle> {
    // Clean up any stale slots from crashed processes
    cleanupStaleSlots();

    // Claim an available slot
    const slot = claimSlot();
    if (!slot) {
        throw new Error('No available slots for E2E testing. All slots are in use.');
    }

    const { config } = slot;

    console.log(`[E2E] Starting services on slot ${config.slot}...`);
    console.log(`[E2E]   Server port: ${config.serverPort}`);
    console.log(`[E2E]   Webapp port: ${config.webappPort}`);

    try {
        // Stop any existing services on this slot first
        try {
            execSync(`${LAUNCHER_PATH} --slot ${config.slot} stop`, {
                stdio: 'pipe',
                timeout: 10000,
            });
        } catch {
            // Ignore errors from stopping non-existent services
        }

        // Start all services using happy-launcher.sh
        execSync(`${LAUNCHER_PATH} --slot ${config.slot} start-all`, {
            stdio: 'inherit',
            timeout: 120000, // 2 minutes for all services to start
            env: {
                ...process.env,
                // Clear any existing HAPPY_* vars to let launcher use slot config
                HAPPY_SERVER_URL: undefined,
                HAPPY_SERVER_PORT: undefined,
                HAPPY_WEBAPP_PORT: undefined,
                HAPPY_WEBAPP_URL: undefined,
                HAPPY_HOME_DIR: undefined,
            },
        });

        // Verify services are running
        console.log(`[E2E] Waiting for server on port ${config.serverPort}...`);
        const serverReady = await waitForPort(config.serverPort, 30000);
        if (!serverReady) {
            throw new Error(`Server failed to start on port ${config.serverPort}`);
        }

        console.log(`[E2E] Waiting for webapp on port ${config.webappPort}...`);
        const webappReady = await waitForWebappReady(config.webappPort, 120000);
        if (!webappReady) {
            throw new Error(`Webapp failed to start on port ${config.webappPort}`);
        }

        console.log(`[E2E] Services ready on slot ${config.slot}`);

        return {
            slot,
            stop: async () => stopServices(slot),
        };
    } catch (err) {
        // Clean up on failure
        slot.release();
        throw err;
    }
}

/**
 * Stop services for a given slot
 */
export async function stopServices(slot: SlotHandle): Promise<void> {
    const { config, release } = slot;

    console.log(`[E2E] Stopping services on slot ${config.slot}...`);

    try {
        execSync(`${LAUNCHER_PATH} --slot ${config.slot} stop`, {
            stdio: 'pipe',
            timeout: 30000,
        });
    } catch (err) {
        console.error(`[E2E] Error stopping services:`, err);
    }

    // Clean up test home directory
    try {
        fs.rmSync(config.homeDir, { recursive: true, force: true });
    } catch {
        // Ignore cleanup errors
    }

    // Release the slot
    release();

    console.log(`[E2E] Services stopped and slot ${config.slot} released`);
}

/**
 * Get the slot configuration for environment variables
 */
export function getEnvForSlot(config: SlotConfig): Record<string, string> {
    return {
        HAPPY_SERVER_URL: config.serverUrl,
        HAPPY_SERVER_PORT: String(config.serverPort),
        HAPPY_WEBAPP_URL: config.webappUrl,
        HAPPY_WEBAPP_PORT: String(config.webappPort),
        HAPPY_HOME_DIR: config.homeDir,
        WEBAPP_URL: config.webappUrl, // Legacy alias used by some tests
    };
}
