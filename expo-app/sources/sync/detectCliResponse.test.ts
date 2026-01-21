import { describe, it, expect } from 'vitest';

import { parseDetectCliRpcResponse } from './detectCliResponse';

describe('parseDetectCliRpcResponse', () => {
    it('parses tmux when present', () => {
        const parsed = parseDetectCliRpcResponse({
            path: '/bin',
            clis: {
                claude: { available: true, resolvedPath: '/bin/claude', version: '0.1.0' },
                codex: { available: false },
                gemini: { available: false },
            },
            tmux: { available: true, resolvedPath: '/bin/tmux', version: '3.3a' },
        });

        expect(parsed).toEqual({
            path: '/bin',
            clis: {
                claude: { available: true, resolvedPath: '/bin/claude', version: '0.1.0' },
                codex: { available: false },
                gemini: { available: false },
            },
            tmux: { available: true, resolvedPath: '/bin/tmux', version: '3.3a' },
        });
    });

    it('omits tmux when absent', () => {
        const parsed = parseDetectCliRpcResponse({
            path: '/bin',
            clis: {
                claude: { available: true },
                codex: { available: false },
                gemini: { available: false },
            },
        });

        expect(parsed).toEqual({
            path: '/bin',
            clis: {
                claude: { available: true },
                codex: { available: false },
                gemini: { available: false },
            },
        });
    });

    it('ignores malformed tmux entry', () => {
        const parsed = parseDetectCliRpcResponse({
            path: '/bin',
            clis: {
                claude: { available: true },
                codex: { available: false },
                gemini: { available: false },
            },
            tmux: { nope: true },
        });

        expect(parsed?.tmux).toBeUndefined();
    });
});

