import { describe, expect, it } from 'vitest';

import { vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));

import {
    selectMcpAppFrameAdapter,
    type McpAppFrameAdapterChoice,
} from './frameAdapter';
import type { McpAppFrameAdapter } from './types';

function choice(label: string): McpAppFrameAdapterChoice {
    const adapter = { support: 'supported', mount: async () => { throw new Error(label); } } as McpAppFrameAdapter;
    return { adapter, View: (() => null) as McpAppFrameAdapterChoice['View'] };
}

describe('selectMcpAppFrameAdapter', () => {
    it.each([
        ['android', 'native'],
        ['ios', 'native'],
        ['web', 'web'],
        ['macos', 'unsupported'],
        ['windows', 'unsupported'],
    ] as const)('selects the %s platform adapter without cross-platform fallback', async (platform, expected) => {
        const selected = selectMcpAppFrameAdapter(platform, {
            native: () => choice('native'),
            web: () => choice('web'),
            unsupported: () => choice('unsupported'),
        });

        await expect(selected.adapter.mount({} as never)).rejects.toThrow(expected);
    });
});
