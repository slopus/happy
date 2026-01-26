import { describe, expect, it } from 'vitest';
import { formatPermissionRequestSummary } from './permissionSummary';

describe('formatPermissionRequestSummary', () => {
    it('prefers permission title when present', () => {
        const summary = formatPermissionRequestSummary({
            toolName: 'unknown',
            toolInput: { permission: { title: 'Access file outside working directory: /etc/hosts' } },
        });
        expect(summary).toBe('Access file outside working directory: /etc/hosts');
    });

    it('summarizes shell command permissions', () => {
        const summary = formatPermissionRequestSummary({
            toolName: 'bash',
            toolInput: { command: 'echo hello' },
        });
        expect(summary).toBe('Run: echo hello');
    });

    it('summarizes file read permissions', () => {
        const summary = formatPermissionRequestSummary({
            toolName: 'read',
            toolInput: { filepath: '/etc/hosts' },
        });
        expect(summary).toBe('Read: /etc/hosts');
    });

    it('summarizes file read permissions from locations[]', () => {
        const summary = formatPermissionRequestSummary({
            toolName: 'read',
            toolInput: { locations: [{ path: '/etc/hosts' }] },
        });
        expect(summary).toBe('Read: /etc/hosts');
    });

    it('summarizes file write permissions from items[]', () => {
        const summary = formatPermissionRequestSummary({
            toolName: 'write',
            toolInput: { items: [{ path: '/tmp/a.txt', type: 'diff' }] },
        });
        expect(summary).toBe('Write: /tmp/a.txt');
    });
});
