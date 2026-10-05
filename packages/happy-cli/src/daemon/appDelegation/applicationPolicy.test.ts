import { describe, expect, it } from 'vitest';
import { loadApplicationPolicy } from './applicationPolicy';
const policy = { appId: 'relationship-advisor', name: 'Advisor', origins: ['https://advisor.paws.rodeo'], capabilities: ['chat' as const, 'images' as const], businessPrompt: { id: 'relationship-advisor', version: '1' } };
describe('trusted application policy', () => {
    it('loads registered business prompt and rejects wrong application, revision and permission', async () => {
        expect((await loadApplicationPolicy('relationship-advisor', ['chat'], async () => policy)).systemPrompt).toContain('relationship');
        await expect(loadApplicationPolicy('other', ['chat'], async () => policy)).rejects.toThrow('permission-denied');
        await expect(loadApplicationPolicy('relationship-advisor', ['chat'], async () => ({ ...policy, businessPrompt: { id: 'relationship-advisor', version: '999' } }))).rejects.toThrow('protocol-incompatible');
        await expect(loadApplicationPolicy('relationship-advisor', ['images'], async () => ({ ...policy, capabilities: ['chat'] }))).rejects.toThrow('permission-denied');
    });
});
