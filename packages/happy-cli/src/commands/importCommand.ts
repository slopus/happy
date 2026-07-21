/**
 * `happy import` command
 *
 * Scans ~/.claude/projects/ for native Claude Code sessions that haven't been
 * imported into Happy yet, creates a happy session per leaf JSONL (mirroring
 * its message history into happy-server), and records the result in
 * ~/.happy/imported-sessions.json so the daemon can later adopt-and-resume
 * them from the mobile app.
 *
 * Flags:
 *   --dry-run             Show what would be imported, don't do anything
 *   --yes / -y            Skip the y/N confirmation prompt
 *   --project <path>      Only import sessions whose cwd starts with <path>
 *   --no-backfill         Create the happy session but don't push messages
 *   --limit <n>           Cap how many candidates are processed in one run
 *
 * Exit codes: 0 success / partial-success, 1 on hard error.
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import { resolve as resolvePath } from 'node:path';

import { ApiClient } from '@/api/api';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';

import { collectHappyTrackedClaudeSessionIds } from '../import/collectHappyTrackedClaudeIds';
import { pruneImportedSessionsOlderThan } from '../import/pruneImported';
import { scanForImportCandidates } from '../import/scanner';
import { importSingleSession, type ImportSessionResult } from '../import/sessionImporter';
import { unarchiveAllImported } from '../import/unarchiveImported';

type ParsedArgs = {
    dryRun: boolean;
    yes: boolean;
    project?: string;
    backfill: boolean;
    limit?: number;
    days?: number;
    fixArchived: boolean;
    pruneOlderThanDays?: number;
    showHelp: boolean;
};

function parseArgs(args: string[]): ParsedArgs {
    const result: ParsedArgs = {
        dryRun: false,
        yes: false,
        backfill: true,
        fixArchived: false,
        showHelp: false,
    };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        switch (arg) {
            case '-h':
            case '--help':
                result.showHelp = true; break;
            case '--dry-run':
                result.dryRun = true; break;
            case '-y':
            case '--yes':
                result.yes = true; break;
            case '--no-backfill':
                result.backfill = false; break;
            case '--project':
                result.project = args[++i]; break;
            case '--limit': {
                const n = parseInt(args[++i] ?? '', 10);
                if (Number.isFinite(n) && n > 0) result.limit = n;
                break;
            }
            case '--days': {
                const n = parseInt(args[++i] ?? '', 10);
                if (Number.isFinite(n) && n > 0) result.days = n;
                break;
            }
            case '--fix-archived':
                result.fixArchived = true; break;
            case '--prune-older-than-days': {
                const n = parseInt(args[++i] ?? '', 10);
                if (Number.isFinite(n) && n > 0) result.pruneOlderThanDays = n;
                break;
            }
            default:
                throw new Error(`Unknown argument: ${arg}`);
        }
    }
    return result;
}

function formatHelp(): string {
    return [
        chalk.bold('happy import') + ' - Make existing local Claude Code sessions visible & resumable in the Happy mobile app',
        '',
        chalk.bold('Usage:'),
        '  happy import [--dry-run] [--yes] [--project <path>] [--days <n>] [--no-backfill] [--limit <n>]',
        '  happy import --fix-archived',
        '',
        chalk.bold('Flags:'),
        '  --dry-run              Show what would be imported without doing it',
        '  -y, --yes              Skip the confirmation prompt',
        '  --project <path>       Only import sessions whose cwd starts with <path>',
        '  --days <n>             Only import sessions modified within the last n days',
        '  --no-backfill          Create the happy session(s) but skip message history',
        '  --limit <n>            Stop after importing n sessions',
        '  --fix-archived         Un-archive every session in the import journal',
        '                         (use this if previously-imported sessions show as',
        '                         "non-active" in the mobile app and you cannot Resume)',
        '',
        chalk.bold('How it works:'),
        '  Scans ~/.claude/projects/<*>/<uuid>.jsonl and for each leaf session (one',
        '  that has not been resumed into a newer JSONL) creates a corresponding',
        '  Happy session on the server, mirrors the message history, and records',
        '  the mapping in ~/.happy/imported-sessions.json. After import the session',
        '  shows up in the mobile app and you can hit "Resume" to continue it.',
        '',
        chalk.bold('Privacy:'),
        '  All session content is end-to-end encrypted before leaving your machine.',
        '  The Happy server only sees opaque ciphertext.',
    ].join('\n');
}

export async function handleImportCommand(args: string[]): Promise<void> {
    let parsed: ParsedArgs;
    try {
        parsed = parseArgs(args);
    } catch (error: any) {
        console.error(chalk.red(`${error.message}`));
        console.error('Run `happy import --help` for usage.');
        process.exit(1);
    }

    if (parsed.showHelp) {
        console.log(formatHelp());
        return;
    }

    // --fix-archived takes a different code path: walk the import journal,
    // un-archive every session there, and exit. No scanning, no new imports.
    if (parsed.fixArchived) {
        const { credentials } = await authAndSetupMachineIfNeeded();
        const api = await ApiClient.create(credentials);
        console.log(chalk.bold('Un-archiving imported sessions...'));
        const results = await unarchiveAllImported(api);
        const cleared = results.filter(r => r.status === 'cleared').length;
        const failed = results.filter(r => r.status === 'failed').length;
        console.log();
        console.log(chalk.green(`  ${cleared} cleared`));
        if (failed > 0) {
            console.log(chalk.red(`  ${failed} failed`));
            for (const r of results.filter(r => r.status === 'failed')) {
                console.log(chalk.dim(`    ${r.happySessionId}: ${r.error}`));
            }
        }
        console.log();
        console.log(chalk.dim('Imported sessions are now in "running + active=false" state.'));
        console.log(chalk.dim('Open one in the mobile app and hit Resume to continue the conversation.'));
        if (failed > 0 && cleared === 0) process.exit(1);
        return;
    }

    // --prune-older-than-days: delete server-side and journal-side any imports
    // whose underlying JSONL hasn't been touched within the cutoff. Useful
    // for walking back accidental backfill of historical sessions.
    if (parsed.pruneOlderThanDays !== undefined) {
        const { credentials } = await authAndSetupMachineIfNeeded();
        const api = await ApiClient.create(credentials);
        const cutoffMs = Date.now() - parsed.pruneOlderThanDays * 24 * 60 * 60 * 1000;
        const cutoffStr = new Date(cutoffMs).toLocaleString();

        console.log(chalk.bold(`Pruning imported sessions whose JSONL is older than ${cutoffStr}...`));
        if (parsed.dryRun) {
            console.log(chalk.dim('(dry-run — no deletions will happen)'));
        }
        const results = await pruneImportedSessionsOlderThan(api, cutoffMs, { dryRun: parsed.dryRun });
        const deleted = results.filter(r => r.status === 'deleted').length;
        const failed = results.filter(r => r.status === 'failed').length;
        const kept = results.filter(r => r.status === 'kept-not-old-enough').length;

        console.log();
        if (deleted > 0) {
            const verb = parsed.dryRun ? 'would delete' : 'deleted';
            console.log(chalk.yellow(`  ${verb} ${deleted}`));
            for (const r of results.filter(r => r.status === 'deleted').slice(0, 30)) {
                console.log(chalk.dim(`    ${r.claudeSessionId.slice(0, 8)}  ${r.cwd}`));
            }
            if (deleted > 30) {
                console.log(chalk.dim(`    ...and ${deleted - 30} more`));
            }
        }
        if (failed > 0) {
            console.log(chalk.red(`  ${failed} failed`));
            for (const r of results.filter(r => r.status === 'failed')) {
                console.log(chalk.dim(`    ${r.happySessionId}: ${r.error}`));
            }
        }
        console.log(chalk.green(`  ${kept} kept (not old enough)`));
        if (failed > 0 && deleted === 0) process.exit(1);
        return;
    }

    const projectFilter = parsed.project ? resolvePath(parsed.project) : undefined;
    const mtimeAfterMs = typeof parsed.days === 'number'
        ? Date.now() - parsed.days * 24 * 60 * 60 * 1000
        : undefined;

    // Build the dedup set BEFORE scanning. This is a network call (one
    // GET /v1/sessions) but lets us skip Claude sessions that happy already
    // knows about — re-importing those would create duplicates.
    process.stdout.write(chalk.dim('Looking up existing happy sessions for dedup... '));
    let happyTrackedClaudeIds: Set<string>;
    try {
        happyTrackedClaudeIds = await collectHappyTrackedClaudeSessionIds();
        console.log(chalk.dim(`(${happyTrackedClaudeIds.size} found)`));
    } catch (error: any) {
        console.log(chalk.yellow(`(failed: ${error?.message ?? error}; importing without dedup)`));
        happyTrackedClaudeIds = new Set();
    }

    const candidates = await scanForImportCandidates({ projectFilter, happyTrackedClaudeIds, mtimeAfterMs });

    if (candidates.length === 0) {
        console.log(chalk.green('Nothing new to import.'));
        console.log(chalk.dim('All Claude leaf sessions in ~/.claude/projects are already in Happy.'));
        return;
    }

    const limited = parsed.limit ? candidates.slice(0, parsed.limit) : candidates;

    console.log(chalk.bold(`\nFound ${limited.length} session${limited.length === 1 ? '' : 's'} to import:\n`));
    for (const c of limited) {
        const title = c.header.firstUserText
            || c.header.summary?.summary
            || chalk.dim('(no preview)');
        const linesNote = c.header.firstCwd ?? chalk.dim('(no cwd)');
        console.log(`  ${chalk.cyan(c.claudeSessionId.slice(0, 8))}  ${chalk.dim(linesNote)}`);
        console.log(`    ${title}`);
    }
    console.log();

    if (parsed.dryRun) {
        console.log(chalk.green('Dry run complete. Run without --dry-run to import.'));
        return;
    }

    if (!parsed.yes) {
        const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
            {
                type: 'confirm',
                name: 'confirm',
                message: `Encrypt and upload ${limited.length} session${limited.length === 1 ? '' : 's'} to happy-server?`,
                default: false,
            },
        ]);
        if (!confirm) {
            console.log(chalk.dim('Aborted.'));
            return;
        }
    }

    const { credentials } = await authAndSetupMachineIfNeeded();
    const api = await ApiClient.create(credentials);

    const results: ImportSessionResult[] = [];
    let successCount = 0;
    let partialCount = 0;
    let failCount = 0;

    for (const candidate of limited) {
        process.stdout.write(`  ${chalk.cyan(candidate.claudeSessionId.slice(0, 8))} ... `);
        try {
            const result = await importSingleSession(api, candidate, { backfill: parsed.backfill });
            results.push(result);
            switch (result.status) {
                case 'created':
                    successCount++;
                    console.log(chalk.green(`ok  (${result.messagesBackfilled} messages)`));
                    break;
                case 'created-no-backfill':
                    successCount++;
                    console.log(chalk.green('ok  (metadata only)'));
                    break;
                case 'partial':
                    partialCount++;
                    console.log(chalk.yellow(`partial (${result.messagesBackfilled} messages) — ${result.error ?? ''}`));
                    break;
                case 'failed':
                    failCount++;
                    console.log(chalk.red(`failed — ${result.error ?? ''}`));
                    break;
            }
        } catch (error: any) {
            failCount++;
            console.log(chalk.red(`failed — ${error?.message ?? error}`));
        }
    }

    console.log();
    console.log(chalk.bold('Summary:'));
    console.log(`  ${chalk.green(`${successCount} succeeded`)}`);
    if (partialCount > 0) console.log(`  ${chalk.yellow(`${partialCount} partial (re-run \`happy import\` to retry)`)}`);
    if (failCount > 0) console.log(`  ${chalk.red(`${failCount} failed`)}`);
    console.log();
    console.log(chalk.dim('Imported sessions now appear in the mobile app. Use Resume on any of them'));
    console.log(chalk.dim('to continue the conversation from where Claude left off.'));

    if (failCount > 0 && successCount === 0) {
        process.exit(1);
    }
}
