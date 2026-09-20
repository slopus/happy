import { describe, it, expect, vi } from 'vitest';
import { SessionsResourceImpl } from './sessions';
import { RecordEncryptionStore } from '../crypto/records';
import { encryptLegacy, decryptLegacy, encodeBase64, decodeBase64 } from '../crypto/encryption';
import type { PawsHttpTransport } from '../transport/http';
import type { PawsRealtimeTransport } from '../transport/realtime';

function fixture(initial: any = { theme: 'dark' }) {
    const credentials = { token: 't', secret: new Uint8Array(32).fill(7) };
    let settings = initial, version = 0, conflict = false;
    const http = {
        getCredentials: vi.fn(async () => credentials),
        getWithCredentials: vi.fn(async () => ({ credentials, data: { settings: settings === null ? null : encodeBase64(encryptLegacy(settings, credentials.secret)), settingsVersion: version } })),
        post: vi.fn(async (_: string, body: any) => {
            if (conflict) { conflict = false; settings = { ...settings, concurrent: true }; version++; return { success: false, error: 'version-mismatch' }; }
            expect(body.expectedVersion).toBe(version);
            settings = decryptLegacy(decodeBase64(body.settings), credentials.secret); version++;
            return { success: true, version };
        }),
    };
    const rpc = vi.fn(async () => ({ type: 'success', sessionId: 's' }));
    const sdk = new SessionsResourceImpl(http as unknown as PawsHttpTransport, { machineRpc: rpc } as unknown as PawsRealtimeTransport, new RecordEncryptionStore(), async () => [{ id: 'm' }] as any);
    vi.spyOn(sdk, 'get').mockResolvedValue({ id: 's' } as any);
    return { sdk, http, rpc, get settings() { return settings; }, set conflict(v: boolean) { conflict = v; } };
}
describe('account session organization', () => {
    it('creates named classification, preserves settings and reuses names on retry', async () => {
        const f = fixture();
        const first = await f.sdk.organize('s', { listName: 'MISS', tagNames: ['视频采集'] });
        const next = await f.sdk.organize('s', { listName: 'MISS', tagNames: ['视频采集'] });
        expect(next).toEqual(first);
        expect(f.settings.theme).toBe('dark');
        expect(f.settings.sidebarOrganization.lists).toHaveLength(1);
        expect(f.settings.sidebarOrganization.tags).toHaveLength(1);
        expect(f.settings.sidebarOrganization.sessions.s).toEqual(first);
        expect(f.http.post).toHaveBeenCalledTimes(1);
    });
    it('rebases after version conflict and preserves concurrent changes', async () => {
        const f = fixture(); f.conflict = true;
        await f.sdk.organize('s', { listName: 'MISS' });
        expect(f.settings.concurrent).toBe(true);
        expect(f.http.post).toHaveBeenCalledTimes(2);
    });
    it('supports existing IDs and clearing, leaves omitted tags intact', async () => {
        const f = fixture();
        const a = await f.sdk.organize('s', { listName: 'MISS', tagNames: ['采集'] });
        expect(await f.sdk.organize('s', { listId: null })).toEqual({ listId: null, tagIds: a.tagIds });
        expect(await f.sdk.organize('s', { listId: a.listId!, tagIds: [] })).toEqual({ listId: a.listId, tagIds: [] });
        await expect(f.sdk.organize('s', { tagIds: ['missing'] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
    it('rejects malformed settings instead of overwriting them', async () => {
        const f = fixture({ sidebarOrganization: { lists: 'bad', tags: [], sessions: {} } });
        await expect(f.sdk.organize('s', { listName: 'MISS' })).rejects.toMatchObject({ code: 'PROTOCOL_UNSUPPORTED' });
        expect(f.http.post).not.toHaveBeenCalled();
    });
    it('validates before spawn and reports partial success without hiding the session ID', async () => {
        const f = fixture();
        await expect(f.sdk.spawn({ machineId: 'm', directory: '/x', organization: { listName: '' } })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
        expect(f.rpc).not.toHaveBeenCalled();
        f.http.post.mockRejectedValue(new Error('offline'));
        await expect(f.sdk.spawn({ machineId: 'm', directory: '/x', organization: { listName: 'MISS' } })).rejects.toMatchObject({ details: { sessionId: 's', sessionCreated: true } });
        expect(f.rpc).toHaveBeenCalledTimes(1);
    });
});

it('preserves unknown organization fields and unrelated assignments', async () => {
    const f = fixture({ futureSetting: { enabled: true }, sidebarOrganization: {
        futureIndex: ['keep'], lists: [{ id: 'l', name: 'Existing', kind: 'future-kind', future: 9 }],
        tags: [{ id: 't', name: 'Tag', future: 8 }], sessions: { other: { listId: 'l', tagIds: ['t'], future: 7 } },
    } });
    await f.sdk.organize('s', { listId: 'l', tagIds: ['t'] });
    expect(f.settings.futureSetting).toEqual({ enabled: true });
    expect(f.settings.sidebarOrganization.futureIndex).toEqual(['keep']);
    expect(f.settings.sidebarOrganization.sessions.other.future).toBe(7);
    expect(f.settings.sidebarOrganization.lists[0].future).toBe(9);
});
it('rejects duplicate names and invalid inputs without writing', async () => {
    const f = fixture({ sidebarOrganization: { lists: [{id:'a',name:'MISS'}, {id:'b',name:'MISS'}], tags:[], sessions:{} } });
    await expect(f.sdk.organize('s', { listName: 'MISS' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    for (const input of [{listId:'a',listName:'MISS'}, {tagIds:['t'],tagNames:['Tag']}, {tagNames:[' ']}, {tagIds:Array(101).fill('t')}]) {
        await expect(f.sdk.organize('s', input)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
    expect(f.http.post).not.toHaveBeenCalled();
});
it('fails closed on invalid ciphertext and denied session ownership', async () => {
    const f = fixture();
    f.http.getWithCredentials.mockResolvedValueOnce({credentials:{token:'t',secret:new Uint8Array(32).fill(7)},data:{settings:'invalid',settingsVersion:0}});
    await expect(f.sdk.organize('s', {listName:'MISS'})).rejects.toMatchObject({code:'DECRYPTION_FAILED'});
    vi.mocked(f.sdk.get).mockRejectedValue(new Error('forbidden'));
    await expect(f.sdk.organize('foreign', {listName:'MISS'})).rejects.toThrow('forbidden');
    expect(f.http.post).not.toHaveBeenCalled();
});
it('bounds retries for continuously contended settings', async () => {
    const f = fixture();
    f.http.post.mockImplementation(async()=>({success:false,error:'version-mismatch'}) as any);
    await expect(f.sdk.organize('s',{listName:'MISS'})).rejects.toMatchObject({code:'CONNECTION_LOST'});
    expect(f.http.post).toHaveBeenCalledTimes(4);
});
it('returns organization catalog and assigns during successful spawn', async () => {
    const f = fixture(null);
    expect(await f.sdk.getOrganization()).toEqual({lists:[],tags:[],sessions:{}});
    expect(await f.sdk.spawn({machineId:'m',directory:'/x',organization:{listName:'MISS',tagNames:['Video']}})).toEqual({type:'success',sessionId:'s'});
    expect((await f.sdk.getOrganization()).sessions.s.tagIds).toHaveLength(1);
});

it('refuses an account change between ownership check and settings read', async()=>{
 const f=fixture();
 f.http.getCredentials.mockResolvedValue({token:'other',secret:new Uint8Array(32).fill(9)});
 await expect(f.sdk.organize('s',{listName:'MISS'})).rejects.toMatchObject({code:'AUTH_EXPIRED'});
 expect(f.http.post).not.toHaveBeenCalled();
});
