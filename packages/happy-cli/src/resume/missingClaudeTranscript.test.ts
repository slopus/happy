import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Metadata } from '@/api/types';

import { missingClaudeTranscriptReason } from './handleResumeCommand';

/**
 * Real filesystem, not a mock: the whole point of the check is that the
 * transcript is a file outside Happy's control, so a test that stubs
 * `existsSync` would pass no matter what path the code computes.
 */
let claudeConfigDir: string;
let workdir: string;
let previousClaudeConfigDir: string | undefined;

function baseMetadata(overrides: Partial<Metadata> = {}): Metadata {
    return {
        path: workdir,
        host: 'localhost',
        homeDir: '/tmp',
        happyHomeDir: '/tmp/.happy',
        happyLibDir: '/tmp/happy',
        happyToolsDir: '/tmp/happy/tools',
        ...overrides,
    } as Metadata;
}

function writeTranscript(sessionId: string): void {
    const slug = resolve(workdir).replace(/[^a-zA-Z0-9-]/g, '-');
    const projectDir = join(claudeConfigDir, 'projects', slug);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), '{"uuid":"x"}\n');
}

beforeEach(() => {
    claudeConfigDir = mkdtempSync(join(tmpdir(), 'happy-claude-config-'));
    workdir = mkdtempSync(join(tmpdir(), 'happy-workdir-'));
    previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
});

afterEach(() => {
    if (previousClaudeConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
    } else {
        process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
    }
    rmSync(claudeConfigDir, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
});

describe('missingClaudeTranscriptReason', () => {
    it('reports the missing transcript by path so the user knows what is gone', () => {
        const metadata = baseMetadata({ flavor: 'claude', claudeSessionId: 'e2eb869c-a1c7-4875-be6b-c05a8f11bbd3' });

        const reason = missingClaudeTranscriptReason(metadata);

        expect(reason).toContain('e2eb869c-a1c7-4875-be6b-c05a8f11bbd3.jsonl');
        expect(reason).toContain('cannot be resumed');
    });

    it('allows the resume when the transcript is still there', () => {
        writeTranscript('93a9705e-bc6a-406d-8dce-8acc014dedbd');
        const metadata = baseMetadata({ flavor: 'claude', claudeSessionId: '93a9705e-bc6a-406d-8dce-8acc014dedbd' });

        expect(missingClaudeTranscriptReason(metadata)).toBeNull();
    });

    it('treats a record with no explicit flavor as Claude', () => {
        const metadata = baseMetadata({ claudeSessionId: '93a9705e-bc6a-406d-8dce-8acc014dedbd' });

        expect(missingClaudeTranscriptReason(metadata)).not.toBeNull();
    });

    it('leaves Codex sessions alone: their threads are not stored as Claude transcripts', () => {
        const metadata = baseMetadata({ flavor: 'codex', codexThreadId: '019ccca5-726b-7c61-b914-16de27dfab6e' });

        expect(missingClaudeTranscriptReason(metadata)).toBeNull();
    });

    it('says nothing when there is no Claude session ID to look up', () => {
        expect(missingClaudeTranscriptReason(baseMetadata({ flavor: 'claude' }))).toBeNull();
    });
});
