/**
 * Attach Command Handler
 *
 * Attaches an existing Claude Code session to happy for mobile viewing.
 * Reads the JSONL session file, backfills messages to a new happy session,
 * and optionally registers a Stop hook for ongoing sync.
 *
 * Usage: happy attach <claude-session-id>
 *
 * @module commands/attach
 */

import chalk from 'chalk';
import os from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';

import { readCredentials, readSettings } from '@/persistence';
import { ApiClient } from '@/api/api';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { RawJSONLinesSchema, type RawJSONLines } from '@/claude/types';
import { getProjectPath } from '@/claude/utils/path';
import { configuration } from '@/configuration';
import { projectPath } from '@/projectPath';
import { logger } from '@/ui/logger';
import { readSyncState, writeSyncState, type SyncState } from '@/commands/syncState';
import packageJson from '../../package.json';

/** CLI binary name, overridable via HAPPY_CLI_BIN for testing with alternate builds */
const CLI_BIN = process.env.HAPPY_CLI_BIN || 'happy';

/** UUID v4 format check (loose) */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Batch size for backfilling messages to the server */
const BATCH_SIZE = 50;

/**
 * Sort JSONL messages by following the parentUuid chain (BFS from roots).
 *
 * Claude Code JSONL files store messages with `uuid` and `parentUuid` fields.
 * The conversation tree must be linearised in parent-first order so that the
 * turn structure is preserved when replayed into happy.
 */
function sortByParentChain(messages: RawJSONLines[]): RawJSONLines[] {
    const byUuid = new Map<string, RawJSONLines>();
    const childrenOf = new Map<string, RawJSONLines[]>();
    const roots: RawJSONLines[] = [];

    for (const msg of messages) {
        const uuid = (msg as any).uuid as string | undefined;
        const parentUuid = (msg as any).parentUuid as string | undefined | null;

        if (uuid) {
            byUuid.set(uuid, msg);
        }

        if (!parentUuid) {
            roots.push(msg);
        } else {
            const siblings = childrenOf.get(parentUuid) ?? [];
            siblings.push(msg);
            childrenOf.set(parentUuid, siblings);
        }
    }

    // BFS traversal from roots
    const sorted: RawJSONLines[] = [];
    const queue: RawJSONLines[] = [...roots];

    while (queue.length > 0) {
        const current = queue.shift()!;
        sorted.push(current);

        const uuid = (current as any).uuid as string | undefined;
        if (uuid && childrenOf.has(uuid)) {
            queue.push(...childrenOf.get(uuid)!);
        }
    }

    // If some messages were unreachable (orphans), append them at the end
    if (sorted.length < messages.length) {
        const seen = new Set(sorted);
        for (const msg of messages) {
            if (!seen.has(msg)) {
                sorted.push(msg);
            }
        }
    }

    return sorted;
}

/**
 * Attempt to register the `happy sync` Stop hook in `~/.claude/settings.json`.
 *
 * Returns `true` if the hook is already present or was successfully added,
 * `false` if the registration failed (caller should print manual instructions).
 */
function registerStopHook(): boolean {
    const claudeSettingsPath = join(os.homedir(), '.claude', 'settings.json');

    try {
        let settings: any = {};
        if (existsSync(claudeSettingsPath)) {
            settings = JSON.parse(readFileSync(claudeSettingsPath, 'utf-8'));
        }

        // Ensure hooks structure exists
        if (!settings.hooks) {
            settings.hooks = {};
        }
        if (!Array.isArray(settings.hooks.Stop)) {
            settings.hooks.Stop = [];
        }

        // Check if the hook is already registered
        const alreadyRegistered = settings.hooks.Stop.some((entry: any) => {
            if (!Array.isArray(entry.hooks)) return false;
            return entry.hooks.some(
                (h: any) => h.type === 'command' && h.command === `${CLI_BIN} sync`
            );
        });

        if (alreadyRegistered) {
            logger.debug('[attach] Stop hook already registered in Claude settings');
            return true;
        }

        // Add the hook entry
        settings.hooks.Stop.push({
            matcher: '',
            hooks: [
                {
                    type: 'command',
                    command: `${CLI_BIN} sync`,
                },
            ],
        });

        writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2));
        logger.debug('[attach] Stop hook registered in Claude settings');
        return true;
    } catch (error) {
        logger.debug('[attach] Failed to register Stop hook:', error);
        return false;
    }
}

/**
 * Main handler for `happy attach <session-id>`.
 *
 * Reads a Claude Code JSONL session file, creates a corresponding happy
 * session, backfills all user/assistant messages, and sets up ongoing sync.
 */
export async function handleAttachCommand(args: string[]): Promise<void> {
    // ── Step 1: Parse args ──────────────────────────────────────────────
    const sessionId = args[0];

    if (!sessionId || sessionId === '--help' || sessionId === '-h') {
        console.log(`
${chalk.bold('happy attach')} - Attach a Claude Code session for mobile viewing

${chalk.bold('Usage:')}
  happy attach <session-id>    Attach an existing Claude Code session

${chalk.bold('Arguments:')}
  session-id    The Claude Code session UUID (from ~/.claude/projects/)

${chalk.bold('Example:')}
  happy attach a1b2c3d4-e5f6-7890-abcd-ef1234567890
`);
        return;
    }

    if (!UUID_REGEX.test(sessionId)) {
        console.error(chalk.red(`Error: Invalid session ID format. Expected a UUID, got: ${sessionId}`));
        process.exit(1);
    }

    // ── Step 2: Check credentials ───────────────────────────────────────
    const credentials = await readCredentials();
    if (!credentials) {
        console.error(chalk.red('Error: Not authenticated. Run `happy auth login` first.'));
        process.exit(1);
    }

    // ── Step 3: Check settings (machineId) ──────────────────────────────
    const settings = await readSettings();
    if (!settings.machineId) {
        console.error(chalk.red('Error: Machine not registered. Run `happy daemon start` first.'));
        process.exit(1);
    }

    // ── Step 4: Check idempotency ───────────────────────────────────────
    const existingState = readSyncState(sessionId);
    if (existingState) {
        console.log(chalk.green('Session already attached to happy.'));
        console.log(chalk.gray(`  Happy session: ${existingState.happySessionId}`));
        return;
    }

    // ── Step 5: Find and read session JSONL ─────────────────────────────
    // Try CWD-based path first, then search all project directories
    const jsonlFilename = `${sessionId}.jsonl`;
    let jsonlPath = join(getProjectPath(process.cwd()), jsonlFilename);

    if (!existsSync(jsonlPath)) {
        const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(os.homedir(), '.claude');
        const projectsDir = join(claudeConfigDir, 'projects');
        let found = false;

        if (existsSync(projectsDir)) {
            for (const dir of readdirSync(projectsDir, { withFileTypes: true })) {
                if (!dir.isDirectory()) continue;
                const candidate = join(projectsDir, dir.name, jsonlFilename);
                if (existsSync(candidate)) {
                    jsonlPath = candidate;
                    found = true;
                    break;
                }
            }
        }

        if (!found) {
            console.error(chalk.red(`Error: Session file not found: ${jsonlFilename}`));
            console.error(chalk.gray(`Searched in ~/.claude/projects/ subdirectories.`));
            process.exit(1);
        }
    }

    console.log(chalk.gray(`Reading session file: ${jsonlPath}`));

    const rawContent = readFileSync(jsonlPath, 'utf-8');
    const lines = rawContent.split('\n').filter((line) => line.trim() !== '');

    // ── Step 6: Parse and filter messages ───────────────────────────────
    const parsed: RawJSONLines[] = [];
    for (const line of lines) {
        try {
            const json = JSON.parse(line);
            const result = RawJSONLinesSchema.safeParse(json);
            if (result.success) {
                const msg = result.data;
                if (msg.type === 'user' || msg.type === 'assistant') {
                    parsed.push(msg);
                }
            }
        } catch {
            // Skip malformed lines silently
            logger.debug('[attach] Skipping malformed JSONL line');
        }
    }

    if (parsed.length === 0) {
        console.error(chalk.yellow('Warning: No user/assistant messages found in the session file.'));
        console.error(chalk.gray('The session may be empty or contain only system/summary messages.'));
        process.exit(1);
    }

    console.log(chalk.gray(`Parsed ${parsed.length} messages from ${lines.length} lines`));

    // ── Step 7: Sort by parentUuid chain ────────────────────────────────
    const sorted = sortByParentChain(parsed);

    // ── Step 8: Create API client and register machine ──────────────────
    const api = await ApiClient.create(credentials);
    await api.getOrCreateMachine({
        machineId: settings.machineId,
        metadata: {
            host: os.hostname(),
            platform: os.platform(),
            happyCliVersion: packageJson.version,
            homeDir: os.homedir(),
            happyHomeDir: configuration.happyHomeDir,
            happyLibDir: projectPath(),
        },
    });

    // ── Step 9: Create session metadata ─────────────────────────────────
    const { state, metadata } = createSessionMetadata({
        flavor: 'claude',
        machineId: settings.machineId,
        startedBy: 'terminal',
    });

    // ── Step 10: Create happy session ───────────────────────────────────
    const sessionTag = `claude-attach-${sessionId}`;
    const session = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
    if (!session) {
        console.error(chalk.red('Error: Failed to create happy session. Check server connectivity.'));
        process.exit(1);
    }

    // Steps 11-17 are wrapped in try-catch to clean up the server session on failure.
    // Without this, a partial failure (e.g. backfill crash) leaves an empty ghost
    // session on the phone that can't be archived.
    try {
        // ── Step 11: Get ApiSessionClient ───────────────────────────────
        const sessionClient = api.sessionSyncClient(session);

        // ── Step 12: Register user message callback (establishes Socket.IO)
        sessionClient.onUserMessage((msg) => {
            // v1: Can't inject into Claude Code, just acknowledge
            logger.debug('[attach] Message received from phone:', msg);
        });

        // ── Step 13: Backfill messages in batches ───────────────────────
        console.log(chalk.gray(`Backfilling ${sorted.length} messages...`));

        for (let i = 0; i < sorted.length; i++) {
            sessionClient.sendClaudeSessionMessage(sorted[i]);
            if ((i + 1) % BATCH_SIZE === 0) {
                await sessionClient.flush();
                await new Promise((r) => setTimeout(r, 100));
                logger.debug(`[attach] Flushed batch ${Math.floor((i + 1) / BATCH_SIZE)}`);
            }
        }

        // ── Step 14: Close backfill turn and flush ──────────────────────
        sessionClient.closeClaudeSessionTurn('completed');
        await sessionClient.flush();

        // ── Step 15: Save sync state ────────────────────────────────────
        const syncState: SyncState = {
            happySessionId: session.id,
            claudeSessionId: sessionId,
            lastSyncedLine: lines.length,
            encryptionKey: Buffer.from(session.encryptionKey).toString('base64'),
            encryptionVariant: session.encryptionVariant,
            metadataPath: process.cwd(),
            sessionTag,
            createdAt: new Date().toISOString(),
        };
        writeSyncState(sessionId, syncState);

        // ── Step 16: Register Stop hook ─────────────────────────────────
        const hookRegistered = registerStopHook();

        if (!hookRegistered) {
            console.log('');
            console.log(chalk.yellow('Could not automatically register the Stop hook.'));
            console.log(chalk.yellow('Add the following to ~/.claude/settings.json manually:'));
            console.log('');
            console.log(chalk.gray(JSON.stringify({
                hooks: {
                    Stop: [{
                        matcher: '',
                        hooks: [{ type: 'command', command: `${CLI_BIN} sync` }],
                    }],
                },
            }, null, 2)));
        }

        // ── Step 17: Output results and close ───────────────────────────
        console.log('');
        console.log(chalk.green('Session attached to happy!'));
        console.log(chalk.gray(`  Happy Session: ${session.id}`));
        console.log(chalk.gray(`  Messages synced: ${sorted.length}`));
        console.log(chalk.gray(`  Ongoing sync: ${hookRegistered ? 'Stop hook registered' : 'Add hook manually (see above)'}`));

        await sessionClient.close();
    } catch (error) {
        // Clean up the server session to prevent ghost entries on the phone
        logger.debug('[attach] Backfill failed, deleting server session:', session.id);
        try {
            await api.deleteSession(session.id);
        } catch (deleteError) {
            logger.debug('[attach] Failed to delete session during cleanup:', deleteError);
        }
        throw error;
    }
}
