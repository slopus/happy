import { describe, expect, it } from 'vitest';
import { contextPlugins, contextSessions, contextSites, filterContextItems } from './contextItems';
import type { Session } from '@/sync/storageTypes';
import type { Message } from '@/sync/typesMessage';
const session = (id: string, changes = {}): Session => ({ id, createdAt: 1, updatedAt: 10000, lastMessageAt: 2, metadata: { summary: { text: id }, path: '/work' }, ...changes } as unknown as Session);
const name = (s: Session) => s.metadata!.summary!.text;
const preview = (state: string, createdAt = 1, extra = {}): Message => ({ kind: 'tool-call', createdAt, tool: { name: 'interactive-preview', input: { version: 1, id: '12345678-1234-4234-8234-123456789012', title: 'My site', state, url: 'https://example.test/', ...extra } }, children: [] } as unknown as Message);
describe('context source selection', () => {
    it('excludes current, archived and personal sessions and ignores metadata heartbeat recency', () => {
        const sessions = { current: session('current'), old: session('old', { updatedAt: 999999 }), recent: session('recent', { lastMessageAt: 20 }), personal: session('personal', { metadata: { flavor: 'personal' } }), archived: session('archived', { metadata: { lifecycleState: 'archived' } }) };
        expect(contextSessions(sessions, 'current', name).map(s => s.id)).toEqual(['session:recent', 'session:old']);
    });
    it('can find loaded sessions beyond the first 30 recommendations', () => {
        const sessions = Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`s${i}`, session(`s${i}`, { lastMessageAt: 50 - i })]));
        expect(filterContextItems(contextSessions(sessions, undefined, name), 'sessions', 's44')).toHaveLength(1);
    });
    it('only exposes installed plugin identity and public description, not configuration', () => {
        const manifest = { id: 'demo', title: { default: 'Demo' }, description: { default: 'Tool' } };
        const plugins = [{ manifest, status: { installed: true, configuration: { token: 'private-secret' } } }, { manifest: { ...manifest, id: 'other' }, status: { installed: false } }] as any;
        const result = contextPlugins(plugins, text => text.default);
        expect(result).toHaveLength(1); expect(JSON.stringify(result)).not.toContain('private-secret'); expect(result[0].text).toContain('plugin:demo');
    });
    it('keeps fuzzy file results instead of applying a second strict search', () => {
        const item = { id: 'file', category: 'files', title: 'MessageComposer.tsx', detail: '', text: '@MessageComposer.tsx', icon: 'document-text-outline' } as const;
        expect(filterContextItems([item], 'files', 'MesageComposer')).toHaveLength(1);
    });
    it('excludes expired/non-ready previews and respects later superseding cards', () => {
        expect(contextSites({ s: { messages: [preview('ready', 1), preview('expired', 2)] } })).toEqual([]);
        expect(contextSites({ s: { messages: [preview('ready', 1, { expiresAt: 5 })] } }, 6)).toEqual([]);
        expect(contextSites({ s: { messages: [preview('ready', 3)] } })[0].text).toBe('[My site](https://example.test/)');
    });
    it('rejects executable URLs and URLs containing credentials', () => {
        for (const url of ['javascript:alert(1)', 'https://user:secret@example.test']) expect(contextSites({ s: { messages: [preview('ready', 1, { url })] } })).toEqual([]);
    });
});
