import { describe, expect, it, vi } from 'vitest';

import { listInferenceTokens } from '@/modules/inference-tokens/listInferenceTokens';

describe('listInferenceTokens', () => {
    it('never exposes plugin vault records through the legacy inference-token list', async () => {
        const findMany = vi.fn(async () => [
            { vendor: 'openai', token: new Uint8Array([1]) },
            { vendor: 'plugin:relationship-advisor', token: new Uint8Array([2]) },
        ]);
        const decrypt = vi.fn((_path: string[], token: Uint8Array) => `plain-${token[0]}`);

        await expect(listInferenceTokens('user-1', { findMany }, decrypt)).resolves.toEqual([
            { vendor: 'openai', token: 'plain-1' },
        ]);
        expect(decrypt).toHaveBeenCalledTimes(1);
    });
});
