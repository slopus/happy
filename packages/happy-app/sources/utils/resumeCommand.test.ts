import { describe, expect, it } from 'vitest';
import { buildResumeCommand, buildResumeCommandBlock } from './resumeCommand';

describe('buildResumeCommand', () => {
    it('builds a Claude resume command that enters the session directory first', () => {
        expect(buildResumeCommand({
            path: '/tmp/project',
            os: 'darwin',
            flavor: 'claude',
            claudeSessionId: '93a9705e-bc6a-406d-8dce-8acc014dedbd',
        })).toBe(`cd '/tmp/project' && happy claude --resume 93a9705e-bc6a-406d-8dce-8acc014dedbd`);
    });

    it('builds a Windows Codex resume command using PowerShell directory navigation', () => {
        expect(buildResumeCommand({
            path: 'C:\\Users\\test\\project',
            os: 'win32',
            flavor: 'codex',
            codexThreadId: '019ccca5-726b-7c61-b914-16de27dfab6e',
        })).toBe(`Set-Location -LiteralPath 'C:\\Users\\test\\project'; happy codex --resume 019ccca5-726b-7c61-b914-16de27dfab6e`);
    });

    it('falls back to the bare resume command when no path is available', () => {
        expect(buildResumeCommand({
            flavor: 'claude',
            claudeSessionId: '93a9705e-bc6a-406d-8dce-8acc014dedbd',
        })).toBe('happy claude --resume 93a9705e-bc6a-406d-8dce-8acc014dedbd');
    });

    it('returns null when there is no resumable session identifier', () => {
        expect(buildResumeCommand({
            path: '/tmp/project',
            flavor: 'claude',
        })).toBeNull();
    });
});

describe('buildResumeCommandBlock', () => {
    it('builds copyable two-line CLI instructions when a path is available', () => {
        expect(buildResumeCommandBlock({
            path: '/tmp/project',
            os: 'darwin',
            flavor: 'claude',
            claudeSessionId: '93a9705e-bc6a-406d-8dce-8acc014dedbd',
        })).toEqual({
            lines: [
                `cd '/tmp/project'`,
                'happy claude --resume 93a9705e-bc6a-406d-8dce-8acc014dedbd',
            ],
            copyText: `cd '/tmp/project'\nhappy claude --resume 93a9705e-bc6a-406d-8dce-8acc014dedbd`,
        });
    });

    it('falls back to a single-line command block when no path is available', () => {
        expect(buildResumeCommandBlock({
            flavor: 'claude',
            claudeSessionId: '93a9705e-bc6a-406d-8dce-8acc014dedbd',
        })).toEqual({
            lines: ['happy claude --resume 93a9705e-bc6a-406d-8dce-8acc014dedbd'],
            copyText: 'happy claude --resume 93a9705e-bc6a-406d-8dce-8acc014dedbd',
        });
    });

    it('builds copyable two-line Windows instructions using PowerShell directory navigation', () => {
        expect(buildResumeCommandBlock({
            path: 'C:\\Users\\test\\project',
            os: 'win32',
            flavor: 'claude',
            claudeSessionId: '93a9705e-bc6a-406d-8dce-8acc014dedbd',
        })).toEqual({
            lines: [
                `Set-Location -LiteralPath 'C:\\Users\\test\\project'`,
                'happy claude --resume 93a9705e-bc6a-406d-8dce-8acc014dedbd',
            ],
            copyText: `Set-Location -LiteralPath 'C:\\Users\\test\\project'\nhappy claude --resume 93a9705e-bc6a-406d-8dce-8acc014dedbd`,
        });
    });
});
