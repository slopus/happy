import { describe, expect, it } from 'vitest';
import { rigMetadataFixture } from '@/sync/__testdata__/rigMetadata';
import type { Metadata } from '@/sync/storageTypes';
import { messageSentClient, messageSentSessionProperties } from './messageSentProperties';

const props = (
    metadata: Metadata | null | undefined,
    mode: Parameters<typeof messageSentSessionProperties>[2],
    machinePlatform?: string | null,
) => messageSentSessionProperties('ios', metadata, mode, machinePlatform);

const bot = { id: 'bot-1', name: 'Chief of Staff', username: 'chief', workspaceId: 'w-1', orderKey: '1' };

describe('messageSentSessionProperties', () => {
    it('reports Happy Agent version, model, provider kind and effort from the sent mode', () => {
        expect(messageSentSessionProperties('desktop', rigMetadataFixture, {
            model: 'shared-model',
            modelProviderId: 'claude',
            effort: 'max',
        }, null, (providerId) => `hash(${providerId})`)).toEqual({
            client: 'desktop',
            target: 'session',
            bot_system_key: null,
            task_depth: null,
            session_client: 'happy_agent',
            happy_agent_version: '0.0.30',
            model: 'shared-model',
            model_provider_kind: 'claude',
            provider_account_hash: 'hash(claude)',
            effort: 'max',
            agent_os: 'mac',
        });
    });

    it('hashes the account the message went to, or the session provider, and only for Happy Agent', () => {
        const hash = (providerId: string) => `hash(${providerId})`;
        const send = (metadata: Metadata, modelProviderId?: string) =>
            messageSentSessionProperties('ios', metadata, { modelProviderId }, null, hash).provider_account_hash;
        expect(send(rigMetadataFixture, 'claude_extra')).toBe('hash(claude_extra)');
        expect(send(rigMetadataFixture)).toBe('hash(codex)');
        expect(send({ ...rigMetadataFixture, provider: undefined })).toBeNull();
        expect(send({ path: '/r', host: 'h', flavor: 'claude' } as Metadata, 'claude')).toBeNull();
        expect(props(rigMetadataFixture, { modelProviderId: 'claude' }).provider_account_hash).toBeNull();
    });

    it('reports the task depth only when it is a whole number from zero up', () => {
        const depth = (value: unknown) => props({ ...rigMetadataFixture, depth: value } as Metadata, {}).task_depth;
        expect(depth(0)).toBe(0);
        expect(depth(2)).toBe(2);
        expect(depth(undefined)).toBeNull();
        expect(depth(-1)).toBeNull();
        expect(depth(1.5)).toBeNull();
        expect(depth('2')).toBeNull();
    });

    it('reports the provider by its configured type as published, never by its account id', () => {
        const model = (providerId: string, providerKind: string) => ({ providerId, providerKind, id: 'm', code: 'm', value: 'M' });
        const kind = (metadata: Metadata, providerId: string) =>
            props(metadata, { model: 'm', modelProviderId: providerId }).model_provider_kind;
        const bare: Metadata = { ...rigMetadataFixture, models: [], providers: [], provider: undefined };
        expect(kind({ ...bare, models: [model('my_bedrock', 'bedrock')] }, 'my_bedrock')).toBe('bedrock');
        expect(kind({ ...bare, providers: [{ id: 'my_router', kind: 'openrouter', name: 'Mine' }] }, 'my_router')).toBe('openrouter');
        // An older Happy Agent's own `custom` passes through unmapped.
        expect(kind({ ...bare, models: [model('my_proxy', 'custom')] }, 'my_proxy')).toBe('custom');
    });

    it('reports no provider kind rather than inventing one', () => {
        const bare: Metadata = { ...rigMetadataFixture, models: [], providers: [], provider: undefined };
        expect(props(bare, { model: 'm', modelProviderId: 'unknown_account' }).model_provider_kind).toBeNull();
        const kindless: Metadata = { ...bare, models: [{ providerId: 'p', id: 'm', code: 'm', value: 'M' }] };
        expect(props(kindless, { model: 'm', modelProviderId: 'p' }).model_provider_kind).toBeNull();
    });

    it('marks CLI sessions and leaves Happy Agent fields empty', () => {
        const metadata = { path: '/repo', host: 'mac', version: '1.2.5', flavor: 'codex' } as Metadata;
        expect(props(metadata, { model: 'gpt-5.6-sol', effort: 'high' })).toEqual({
            client: 'ios',
            target: 'session',
            bot_system_key: null,
            task_depth: null,
            session_client: 'cli',
            happy_agent_version: null,
            model: 'gpt-5.6-sol',
            model_provider_kind: null,
            provider_account_hash: null,
            effort: 'high',
            agent_os: null,
        });
    });

    it('reads the OS from the session, as Happy Agent and the CLI each write it', () => {
        const os = (value: string) => props({ path: '/r', host: 'h', os: value } as Metadata, {}).agent_os;
        expect(os('darwin 25.6.0')).toBe('mac');
        expect(os('win32 10.0.26100')).toBe('win');
        expect(os('linux')).toBe('linux');
        expect(os('freebsd')).toBe('other');
    });

    it('falls back to the machine platform when the session has no OS', () => {
        const metadata = { path: '/r', host: 'h' } as Metadata;
        expect(props(metadata, {}, 'win32').agent_os).toBe('win');
        expect(props({ ...metadata, os: 'linux 6.8' }, {}, 'darwin').agent_os).toBe('linux');
        expect(props(metadata, {}, '  ').agent_os).toBeNull();
    });

    it('tells bots and the Chief of Staff apart only by the bot system key', () => {
        const target = (metadata: Metadata) => props(metadata, {}).target;
        expect(target({ ...rigMetadataFixture, bot })).toBeNull();
        expect(target({ ...rigMetadataFixture, bot: { ...bot, systemKey: 'chief_of_staff' } })).toBe('chief_of_staff');
        expect(target({ ...rigMetadataFixture, bot: { ...bot, systemKey: null } })).toBe('bot');
        expect(target({ ...rigMetadataFixture, bot: { ...bot, systemKey: 'future_system_bot' } })).toBe('bot');
        expect(props(null, undefined).target).toBeNull();
    });

    it('reports the raw system key of a system bot, never its name or id', () => {
        const key = (metadata: Metadata) => props(metadata, {}).bot_system_key;
        expect(key({ ...rigMetadataFixture, bot: { ...bot, systemKey: 'chief_of_staff' } })).toBe('chief_of_staff');
        expect(key({ ...rigMetadataFixture, bot: { ...bot, systemKey: null } })).toBeNull();
        expect(key({ ...rigMetadataFixture, bot })).toBeNull();
        expect(key(rigMetadataFixture)).toBeNull();
    });

    it('reports null model and effort when the agent default applies', () => {
        const metadata = { path: '/repo', host: 'mac', flavor: 'claude' } as Metadata;
        expect(props(metadata, {})).toMatchObject({ model: null, effort: null });
        expect(props(null, undefined).session_client).toBeNull();
    });
});

describe('messageSentClient', () => {
    it('names the phone by its OS and the web build by where it runs', () => {
        expect(messageSentClient('ios', false)).toBe('ios');
        expect(messageSentClient('android', false)).toBe('android');
        expect(messageSentClient('web', false)).toBe('web');
        expect(messageSentClient('web', true)).toBe('desktop');
    });
});
