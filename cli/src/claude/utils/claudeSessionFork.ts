/**
 * Claude Session Fork Utility
 *
 * Handles forking and truncating Claude sessions for the /duplicate feature.
 * Simply copies the original JSONL file and truncates it at the specified point.
 */

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createReadStream, createWriteStream, unlink } from 'node:fs';
import { copyFile, rename, unlink as unlinkAsync } from 'node:fs/promises';
import { createInterface } from 'node:readline';

export interface ForkAndTruncateResult {
    success: boolean;
    newSessionId?: string;
    errorMessage?: string;
}

/**
 * Fork a Claude session and truncate it at a specific point
 *
 * Steps:
 * 1. Generate a new session ID
 * 2. Copy the original JSONL file to a new file with the new session ID
 * 3. Truncate the new JSONL file: remove all lines from truncateBeforeUuid onwards
 * 4. Return the new session ID
 */
export async function forkAndTruncateSession(
    projectId: string,
    sessionId: string,
    truncateBeforeUuid: string
): Promise<ForkAndTruncateResult> {
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    const projectDir = join(claudeConfigDir, 'projects', projectId);
    const newSessionId = randomUUID();

    const originalJsonlPath = join(projectDir, `${sessionId}.jsonl`);
    const newJsonlPath = join(projectDir, `${newSessionId}.jsonl`);

    try {
        // Step 1: Copy the original file
        await copyFile(originalJsonlPath, newJsonlPath);

        // Step 2: Truncate the new session file at the specified UUID
        const truncateResult = await truncateSessionFile(newJsonlPath, truncateBeforeUuid);

        if (!truncateResult.success) {
            // Clean up the copied file on failure
            try {
                await unlinkAsync(newJsonlPath);
            } catch {
                // Ignore cleanup errors
            }
            return {
                success: false,
                errorMessage: truncateResult.errorMessage
            };
        }

        return {
            success: true,
            newSessionId
        };
    } catch (error) {
        // Clean up the copied file on failure
        try {
            await unlinkAsync(newJsonlPath);
        } catch {
            // Ignore cleanup errors
        }
        return {
            success: false,
            errorMessage: error instanceof Error ? error.message : 'Failed to fork session'
        };
    }
}

/**
 * Truncate a session JSONL file by removing all lines from a specific UUID onwards
 * The line with the UUID and all subsequent lines are removed
 */
async function truncateSessionFile(
    jsonlPath: string,
    truncateBeforeUuid: string
): Promise<{ success: boolean; errorMessage?: string }> {
    const tempPath = `${jsonlPath}.tmp`;

    try {
        const readStream = createReadStream(jsonlPath, { encoding: 'utf8' });
        const writeStream = createWriteStream(tempPath, { encoding: 'utf8' });
        const rl = createInterface({
            input: readStream,
            crlfDelay: Infinity
        });

        let foundTruncationPoint = false;

        for await (const line of rl) {
            if (!line.trim()) {
                // Keep empty lines before truncation point
                if (!foundTruncationPoint) {
                    writeStream.write(line + '\n');
                }
                continue;
            }

            // Check if this line has the truncation UUID
            try {
                const entry = JSON.parse(line);
                if (entry.uuid === truncateBeforeUuid) {
                    // Found the truncation point - stop writing
                    foundTruncationPoint = true;
                    continue;
                }
            } catch {
                // Not valid JSON, but if we haven't found truncation point, keep it
            }

            // Write line if before truncation point
            if (!foundTruncationPoint) {
                writeStream.write(line + '\n');
            }
        }

        // Close the write stream properly
        await new Promise<void>((resolve, reject) => {
            writeStream.end((err: Error | null | undefined) => {
                if (err) reject(err);
                else resolve();
            });
        });

        // Replace original file with truncated version
        await rename(tempPath, jsonlPath);

        return { success: true };
    } catch (error) {
        // Clean up temp file if it exists
        try {
            await new Promise<void>((resolve) => {
                unlink(tempPath, () => resolve());
            });
        } catch {
            // Ignore cleanup errors
        }

        return {
            success: false,
            errorMessage: error instanceof Error ? error.message : 'Failed to truncate session file'
        };
    }
}
