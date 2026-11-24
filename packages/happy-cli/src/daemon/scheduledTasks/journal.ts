/** Protected, atomically replaced scheduling journals. Fixed-session keys do not expire with the normal cache. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { PersistedSession } from '@/persistence';
import { configuration } from '@/configuration';

export interface ScheduledSessionBinding {
    sessionId: string; agent: 'codex' | 'claude'; directory: string; profileId?: string; saved: PersistedSession;
}
export interface ScheduledJournalRun {
    runId: string; taskId: string; phase: 'starting' | 'bound' | 'sending' | 'sent'; sessionId?: string;
}
const uuid = z.string().uuid();
export function scheduleJournalDirectory(token: string, accountIdentity?: Uint8Array): string {
    const scope = createHash('sha256').update(configuration.serverUrl).update('\0').update(accountIdentity ?? token).digest('hex');
    return join(configuration.happyHomeDir, 'scheduled-tasks', scope);
}
export function writeScheduleJournalFile(directory: string, name: string, value: unknown): void {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, name);
    const temporary = path + '.' + randomUUID() + '.tmp';
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    const file = openSync(temporary, 'r');
    try { fsyncSync(file); } finally { closeSync(file); }
    renameSync(temporary, path);
}
export function createScheduleJournal(directory: string) {
    const read = <T>(name: string): T | null => {
        const path = join(directory, name);
        if (!existsSync(path)) return null;
        return JSON.parse(readFileSync(path, 'utf8')) as T;
    };
    return {
        directory,
        readRun(id: string): ScheduledJournalRun | null {
            const value = read<ScheduledJournalRun>(`run-${uuid.parse(id)}.json`);
            if (value && (value.runId !== id || !['starting', 'bound', 'sending', 'sent'].includes(value.phase))) throw new Error('Invalid scheduling journal');
            return value;
        },
        writeRun(value: ScheduledJournalRun): void { writeScheduleJournalFile(directory, `run-${uuid.parse(value.runId)}.json`, value); },
        readBinding(taskId: string, version: number): ScheduledSessionBinding | null {
            const value = read<ScheduledSessionBinding>(`binding-${uuid.parse(taskId)}-${z.number().int().nonnegative().parse(version)}.json`);
            if (value && (!value.sessionId || !value.saved?.encryptionKey || !value.saved.metadata || !['codex', 'claude'].includes(value.agent))) throw new Error('Invalid task conversation binding');
            return value;
        },
        writeBinding(taskId: string, version: number, value: ScheduledSessionBinding): void {
            writeScheduleJournalFile(directory, `binding-${uuid.parse(taskId)}-${z.number().int().nonnegative().parse(version)}.json`, value);
        },
    };
}
