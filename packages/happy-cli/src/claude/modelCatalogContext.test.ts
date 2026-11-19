import { expect, it } from 'vitest';
import { claudeModelConnection, readClaudeModelConnection } from './modelCatalogContext';

it('verifies stable explicit gateways and refuses a changed key, endpoint or alias mapping', () => {
    const settings = { effective: { env: { ANTHROPIC_BASE_URL: 'http://gateway-one', ANTHROPIC_AUTH_TOKEN: 'fixture-key', ANTHROPIC_DEFAULT_OPUS_MODEL: 'vendor/one' } } };
    const first = claudeModelConnection(settings, {}, '/fixture/claude', {});
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(claudeModelConnection(structuredClone(settings), {}, '/fixture/claude', {})).toBe(first);
    for (const [key, value] of [['ANTHROPIC_BASE_URL', 'http://gateway-two'], ['ANTHROPIC_AUTH_TOKEN', 'other-fixture-key'], ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'vendor/two']]) {
        const changed = structuredClone(settings); (changed.effective.env as Record<string, string>)[key] = value;
        expect(claudeModelConnection(changed, {}, '/fixture/claude', {})).not.toBe(first);
    }
});
it('requires effective settings and verifiable auth, including rejecting dynamic helpers', () => {
    expect(claudeModelConnection({}, {}, '/fixture/claude', {})).toBeUndefined();
    expect(claudeModelConnection({ effective: {} }, {}, '/fixture/claude', {})).toBeUndefined();
    expect(claudeModelConnection({ effective: { apiKeyHelper: 'dynamic-helper' } }, {}, '/fixture/claude', { email: 'one', organization: 'org', apiProvider: 'firstParty' })).toBeUndefined();
    expect(claudeModelConnection({ effective: {} }, {}, '/fixture/claude', { email: 'one', organization: 'org', apiProvider: 'firstParty' })).not.toBeUndefined();
});
it('does not require unsupported settings controls on an older CLI', async () => {
    expect(await readClaudeModelConnection({}, {}, '/fixture/claude', {})).toBeUndefined();
});
