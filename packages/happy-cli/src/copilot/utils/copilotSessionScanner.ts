/**
 * Copilot Session Scanner
 * 
 * Watches Copilot's events.jsonl file in real-time and relays new events
 * to the Happy session for mobile app display.
 * 
 * Copilot stores session logs at:
 *   ~/.copilot/session-state/<sessionId>/events.jsonl
 * 
 * Modeled on claude/utils/sessionScanner.ts.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { InvalidateSync } from '@/utils/sync';
import { startFileWatcher } from '@/modules/watcher/startFileWatcher';
import { logger } from '@/ui/logger';
import { CopilotEventMapper, type CopilotEvent } from './copilotEventMapper';
import type { SessionEnvelope } from '@slopus/happy-wire';

const COPILOT_SESSION_STATE_DIR = join(homedir(), '.copilot', 'session-state');

export interface CopilotScannerOptions {
    /** Called for each new session envelope to relay */
    onEnvelope: (envelope: SessionEnvelope) => void;
    /** Called when session ID is detected from session.start event */
    onSessionIdDetected?: (sessionId: string) => void;
}

export async function createCopilotSessionScanner(opts: CopilotScannerOptions) {
    const mapper = new CopilotEventMapper();
    const processedIds = new Set<string>();
    let currentSessionId: string | null = null;
    let stopWatcher: (() => void) | null = null;

    function getEventsPath(sessionId: string): string {
        return join(COPILOT_SESSION_STATE_DIR, sessionId, 'events.jsonl');
    }

    async function readAndProcessEvents() {
        if (!currentSessionId) return;

        const eventsPath = getEventsPath(currentSessionId);
        if (!existsSync(eventsPath)) {
            logger.debug(`[CopilotScanner] Events file not found: ${eventsPath}`);
            return;
        }

        try {
            const content = await readFile(eventsPath, 'utf-8');
            const lines = content.split('\n').filter(l => l.trim());
            let newCount = 0;

            for (const line of lines) {
                try {
                    const event = JSON.parse(line) as CopilotEvent;
                    if (!event.id || processedIds.has(event.id)) continue;

                    processedIds.add(event.id);
                    newCount++;

                    // Detect session ID from session.start
                    if (event.type === 'session.start' && event.data?.sessionId) {
                        const sid = event.data.sessionId as string;
                        opts.onSessionIdDetected?.(sid);
                    }

                    // Map to envelopes and relay
                    const envelopes = mapper.mapEvent(event);
                    for (const envelope of envelopes) {
                        opts.onEnvelope(envelope);
                    }
                } catch (err) {
                    logger.debug(`[CopilotScanner] Error processing event: ${err}`);
                }
            }

            if (newCount > 0) {
                logger.debug(`[CopilotScanner] Processed ${newCount} new events from ${currentSessionId}`);
            }
        } catch (error) {
            logger.debug(`[CopilotScanner] Error reading events: ${error}`);
        }
    }

    const sync = new InvalidateSync(readAndProcessEvents);

    // Periodic fallback sync
    const intervalId = setInterval(() => { sync.invalidate(); }, 3000);

    return {
        /**
         * Start watching a Copilot session by ID.
         * @param sessionId The session UUID
         * @param skipExisting If true, mark existing events as processed (for resumed sessions).
         *                     If false, relay all events including existing ones (for new sessions).
         */
        watchSession(sessionId: string, skipExisting: boolean = true) {
            if (currentSessionId === sessionId) return;

            // Stop previous watcher
            stopWatcher?.();

            currentSessionId = sessionId;
            logger.debug(`[CopilotScanner] Watching session: ${sessionId}, skipExisting: ${skipExisting}`);

            if (skipExisting) {
                // Mark existing events as processed (don't replay history)
                const eventsPath = getEventsPath(sessionId);
                if (existsSync(eventsPath)) {
                    try {
                        const content = require('node:fs').readFileSync(eventsPath, 'utf-8');
                        const lines = content.split('\n').filter((l: string) => l.trim());
                        for (const line of lines) {
                            try {
                                const event = JSON.parse(line) as CopilotEvent;
                                if (event.id) processedIds.add(event.id);
                            } catch { /* skip */ }
                        }
                        logger.debug(`[CopilotScanner] Marked ${processedIds.size} existing events as processed`);
                    } catch { /* ignore */ }
                }
            }

            // Start watching for new events
            stopWatcher = startFileWatcher(getEventsPath(sessionId), () => {
                sync.invalidate();
            });

            // If not skipping, do an immediate sync to relay existing events
            if (!skipExisting) {
                sync.invalidate();
            }
        },

        /**
         * Start scanning by detecting the latest session from filesystem.
         * Use when session ID isn't known yet (fresh start).
         */
        async watchLatestSession() {
            try {
                const entries = require('node:fs').readdirSync(COPILOT_SESSION_STATE_DIR);
                let latest: { id: string; mtime: number } | null = null;

                for (const entry of entries) {
                    if (!/^[0-9a-f]{8}-/.test(entry)) continue;
                    try {
                        const stat = require('node:fs').statSync(join(COPILOT_SESSION_STATE_DIR, entry));
                        if (stat.isDirectory() && (!latest || stat.mtimeMs > latest.mtime)) {
                            latest = { id: entry, mtime: stat.mtimeMs };
                        }
                    } catch { /* skip */ }
                }

                if (latest) {
                    this.watchSession(latest.id);
                }
            } catch {
                logger.debug('[CopilotScanner] Could not scan session-state directory');
            }
        },

        /**
         * Clean up all watchers and timers.
         */
        async cleanup() {
            clearInterval(intervalId);
            stopWatcher?.();
            stopWatcher = null;
            sync.stop();
            logger.debug('[CopilotScanner] Cleaned up');
        },
    };
}

export type CopilotSessionScanner = Awaited<ReturnType<typeof createCopilotSessionScanner>>;
