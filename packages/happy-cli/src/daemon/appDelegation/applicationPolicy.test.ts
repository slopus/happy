import { describe, expect, it } from 'vitest';
import { loadApplicationPolicy } from './applicationPolicy';
import type { BusinessPromptRef } from '@slopus/happy-wire';
const policy = { appId: 'relationship-advisor', name: 'Advisor', origins: ['https://advisor.paws.rodeo'], capabilities: ['chat' as const, 'images' as const], businessPrompt: { id: 'relationship-advisor', version: '1' } };
const resolvePrompt = async (ref: BusinessPromptRef) => ref.id === 'relationship-advisor' && ref.version === '1' ? 'You are a relationship advisor.' : null;
describe('trusted application policy', () => {
    it('requires both application and binding tool authority before issuing a tool policy', async () => {
        const toolsPolicy = { ...policy, capabilities: ['chat' as const, 'tools' as const] };
        const result = await loadApplicationPolicy('relationship-advisor', ['chat', 'tools'], async () => toolsPolicy, resolvePrompt, 'yolo');
        expect(result.systemPrompt).toContain('untrusted input');
        expect(result.systemPrompt).not.toContain('Do not use tools');
        await expect(loadApplicationPolicy('relationship-advisor', ['chat'], async () => toolsPolicy, resolvePrompt, 'yolo')).rejects.toThrow('permission-denied');
        await expect(loadApplicationPolicy('relationship-advisor', ['chat', 'tools'], async () => policy, resolvePrompt, 'yolo')).rejects.toThrow('permission-denied');
        expect((await loadApplicationPolicy('relationship-advisor', ['chat', 'tools'], async () => toolsPolicy, resolvePrompt)).systemPrompt).toContain('Do not use tools');
    });
    it('loads registered business prompt and rejects wrong application, revision and permission', async () => {
        expect((await loadApplicationPolicy('relationship-advisor', ['chat'], async () => policy, resolvePrompt)).systemPrompt).toContain('relationship');
        await expect(loadApplicationPolicy('other', ['chat'], async () => policy, resolvePrompt)).rejects.toThrow('permission-denied');
        await expect(loadApplicationPolicy('relationship-advisor', ['chat'], async () => ({ ...policy, businessPrompt: { id: 'relationship-advisor', version: '999' } }), resolvePrompt)).rejects.toThrow('protocol-incompatible');
        await expect(loadApplicationPolicy('relationship-advisor', ['images'], async () => ({ ...policy, capabilities: ['chat'] }), resolvePrompt)).rejects.toThrow('permission-denied');
    });
    it('loads a second registered application with its distinct prompt and rejects an unknown revision', async () => {
        const second = { appId: 'minimal-app', name: 'Minimal', origins: ['https://minimal.example'], capabilities: ['chat' as const], businessPrompt: { id: 'minimal-app', version: '1' } };
        const resolve = async (ref: BusinessPromptRef) => ref.id === 'minimal-app' && ref.version === '1' ? 'Summarize the topic in one sentence.' : null;
        const result = await loadApplicationPolicy('minimal-app', ['chat'], async () => second, resolve);
        expect(result.systemPrompt).toContain('Summarize the topic in one sentence.');
        expect(result.systemPrompt).toContain('untrusted input');
        expect(result.systemPrompt).not.toContain('relationship');
        await expect(loadApplicationPolicy('minimal-app', ['chat'], async () => ({ ...second, businessPrompt: { id: 'minimal-app', version: '2' } }), resolve)).rejects.toThrow('protocol-incompatible');
    });
});
