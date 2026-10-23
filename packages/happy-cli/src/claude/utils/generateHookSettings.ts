/**
 * Generate temporary settings file with Claude hooks for session tracking
 * 
 * Creates a settings.json file that configures Claude's SessionStart hook
 * to notify our HTTP server when sessions change (new session, resume, compact, etc.)
 */

import { join, resolve } from 'node:path';
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { projectPath } from '@/projectPath';

/**
 * Generate a temporary settings file with SessionStart hook configuration
 * 
 * @param port - The port where Happy server is listening
 * @returns Path to the generated settings file
 */
export function generateHookSettingsFile(port: number): string {
    const hooksDir = join(configuration.happyHomeDir, 'tmp', 'hooks');
    mkdirSync(hooksDir, { recursive: true });

    // Unique filename per process to avoid conflicts
    const filename = `session-hook-${process.pid}.json`;
    const filepath = join(hooksDir, filename);

    // Path to the hook forwarder script
    const forwarderScript = resolve(projectPath(), 'scripts', 'session_hook_forwarder.cjs');
    const hookEntry = (path: string) => [
        {
            matcher: "*",
            hooks: [
                {
                    type: "command",
                    command: `node "${forwarderScript}" ${port} ${path}`
                }
            ]
        }
    ];

    // Stop carries `background_tasks` — the background work (shells, subagents,
    // workflows) still in flight when the turn ends. It is what distinguishes
    // "the turn ended and the session is idle" from "the turn ended but a build
    // is still running", and it arrives in both launch modes because the
    // `claude` binary runs its hooks whether it is driven through the PTY or
    // through the SDK. SessionEnd clears the counts, so a session that exits
    // mid-build leaves no stale activity behind.
    const settings = {
        hooks: {
            SessionStart: hookEntry('/hook/session-start'),
            Stop: hookEntry('/hook/stop'),
            SessionEnd: hookEntry('/hook/session-end')
        }
    };

    writeFileSync(filepath, JSON.stringify(settings, null, 2));
    logger.debug(`[generateHookSettings] Created hook settings file: ${filepath}`);

    return filepath;
}

/**
 * Clean up the temporary hook settings file
 * 
 * @param filepath - Path to the settings file to remove
 */
export function cleanupHookSettingsFile(filepath: string): void {
    try {
        if (existsSync(filepath)) {
            unlinkSync(filepath);
            logger.debug(`[generateHookSettings] Cleaned up hook settings file: ${filepath}`);
        }
    } catch (error) {
        logger.debug(`[generateHookSettings] Failed to cleanup hook settings file: ${error}`);
    }
}

