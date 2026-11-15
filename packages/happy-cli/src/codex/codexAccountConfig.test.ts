import { describe, expect, it } from 'vitest';
import { assertCodexAccountConfig, assertCodexAccountModel, CODEX_ACCOUNT_CONFIG, CODEX_ACCOUNT_HTTP_PROVIDER, CODEX_ACCOUNT_PROVIDER } from './codexAccountConfig';

const config = (overrides: Record<string, unknown> = {}) => ({
    ...CODEX_ACCOUNT_CONFIG,
    model_providers: { [CODEX_ACCOUNT_PROVIDER]: { ...CODEX_ACCOUNT_HTTP_PROVIDER, ...overrides } },
});

describe('account HTTP transport policy', () => {
    it('accepts native config/read optional defaults', () => {
        expect(() => assertCodexAccountConfig(config({ env_key: null, http_headers: null, supports_standalone_web_search: false }))).not.toThrow();
    });
    it.each([
        { supports_websockets: true }, { requires_openai_auth: false },
        { base_url: 'https://other.invalid' }, { env_key: 'OTHER_KEY' },
        { http_headers: { Authorization: 'synthetic' } }, { env_http_headers: { Authorization: 'OTHER_KEY' } },
        { experimental_bearer_token: 'synthetic' }, { auth: {} }, { query_params: {} },
    ])('rejects inherited transport or credential overrides: %j', overrides => {
        expect(() => assertCodexAccountConfig(config(overrides))).toThrow('Device Environment');
    });
    it('rejects an external model catalog reintroduced by another config layer', () => {
        expect(() => assertCodexAccountConfig({ ...config(), model_catalog_json: '/project/magpie-models.json' })).toThrow('Device Environment');
        expect(() => assertCodexAccountConfig({ ...config(), model_catalog_json: null })).not.toThrow();
    });
    it('rejects the old websocket provider and missing HTTP definitions', () => {
        expect(() => assertCodexAccountConfig({ ...config(), model_provider: 'openai' })).toThrow();
        expect(() => assertCodexAccountConfig(CODEX_ACCOUNT_CONFIG)).toThrow();
    });
});


describe('account model selection', () => {
    const models = [{ model: 'gpt-6.1-sol' }, { model: 'gpt-6-astra' }];
    it('accepts the account catalog model and native default', () => {
        expect(() => assertCodexAccountModel('gpt-6.1-sol', models)).not.toThrow();
        expect(() => assertCodexAccountModel(undefined, null)).not.toThrow();
    });
    it.each(['group/daily-auto', 'agy-cli/gemini-4-argon', 'gpt-nonexistent'])(
        'rejects stale or foreign model %s before an account request', model => {
            expect(() => assertCodexAccountModel(model, models)).toThrow('ChatGPT');
        },
    );
    it('does not treat an unavailable catalog as permission for arbitrary models', () => {
        expect(() => assertCodexAccountModel('group/daily-auto', null)).toThrow('catalog');
        expect(() => assertCodexAccountModel('gpt-6.1-sol', [])).toThrow('ChatGPT');
    });
});
