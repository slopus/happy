import { describe, expect, it, vi } from 'vitest';
import type { Thread, InputItem } from './codexAppServerTypes';
import { mapCodexHistoryWithImages } from './codexHistoryImages';
import { buildCodexImageAttachmentNotice } from './codexImageInput';
import { markPawsTurnOrigin } from './codexPrompt';
import { mapCodexThreadToSessionEnvelopes, mapCodexMcpMessageToSessionEnvelopes } from './utils/sessionProtocolMapper';

function history(content: InputItem[]): Pick<Thread, 'turns'> {
    return { turns: [{ id: 'turn', status: 'completed', items: [{ id: 'user', type: 'userMessage', content }] }] };
}
const image = { type: 'localImage' as const, path: '/private/attachments/photo.png' };
const attachment = { ref: 'destination/photo', name: 'photo.png', size: 42, dims: { width: 10, height: 20 }, motionPhoto: null };

describe('mapCodexHistoryWithImages', () => {
    it('keeps previously acknowledged text identities when stripping image instructions', async () => {
        const text = buildCodexImageAttachmentNotice([image]) + '\n\nCompare the image.';
        // Before image replay support the identity included the untouched notice.
        const legacy = mapCodexThreadToSessionEnvelopes(history([{ type: 'text', text }]));
        const replay = await mapCodexHistoryWithImages(history([image, { type: 'text', text }]), {
            uploadImageAttachment: async () => attachment,
        });
        const live = mapCodexMcpMessageToSessionEnvelopes({ type: 'user_message', turn_id: 'turn',
            content: [image, { type: 'text', text }] }, { currentTurnId: 'turn' }).envelopes;
        const previousId = legacy.find(e => e.ev.t === 'text')!.id;
        expect(replay.find(e => e.ev.t === 'text')!.id).toBe(previousId);
        expect(live.find(e => e.ev.t === 'text')!.id).toBe(previousId);
        expect(replay.find(e => e.ev.t === 'text')!.ev).toEqual({ t: 'text', text: 'Compare the image.' });
    });
    it('preserves an image-only request and stable identities across replay retries', async () => {
        const thread = history([image]);
        const first = await mapCodexHistoryWithImages(thread, { uploadImageAttachment: async () => attachment });
        const second = await mapCodexHistoryWithImages(thread, { uploadImageAttachment: async () => ({ ...attachment, ref: 'retry/photo' }) });
        const user = first.filter(e => e.role === 'user');
        expect(user).toHaveLength(1);
        expect(user[0].ev).toMatchObject({ t: 'file', encrypted: true, ref: 'destination/photo' });
        expect(second.map(e => e.id)).toEqual(first.map(e => e.id));
    });

    it('does not upload or duplicate images already sent by this Happy session', async () => {
        const uploadImageAttachment = vi.fn(async () => attachment);
        const envelopes = await mapCodexHistoryWithImages(history([image,
            { type: 'text', text: markPawsTurnOrigin('Look at this', 'own-origin') }]),
        { uploadImageAttachment }, { omitPawsUserMessagesFromOriginToken: 'own-origin' });
        expect(envelopes.filter(e => e.role === 'user')).toEqual([]);
        expect(uploadImageAttachment).not.toHaveBeenCalled();
    });

    it('shows a missing-file placeholder without exposing the local directory', async () => {
        const envelopes = await mapCodexHistoryWithImages(history([image]), {
            uploadImageAttachment: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
        });
        expect(envelopes.filter(e => e.role === 'user').map(e => e.ev)).toEqual([
            { t: 'text', text: '[Historical image unavailable: photo.png]' },
        ]);
    });

    it('propagates upload failures instead of acknowledging incomplete history', async () => {
        await expect(mapCodexHistoryWithImages(history([image]), {
            uploadImageAttachment: async () => { throw new Error('upload unavailable'); },
        })).rejects.toThrow('upload unavailable');
    });

    it('preserves quoted attachment instructions without corresponding typed images', async () => {
        const text = buildCodexImageAttachmentNotice([image])!;
        const envelopes = await mapCodexHistoryWithImages(history([{ type: 'text', text }]), {});
        expect(envelopes.filter(e => e.role === 'user').map(e => e.ev)).toEqual([{ t: 'text', text }]);
    });

    it('uploads a repeated image once but preserves both historical occurrences', async () => {
        const uploadImageAttachment = vi.fn(async () => attachment);
        const envelopes = await mapCodexHistoryWithImages(history([image, image]), { uploadImageAttachment });
        const files = envelopes.filter(e => e.ev.t === 'file');
        expect(files).toHaveLength(2);
        expect(new Set(files.map(e => e.id)).size).toBe(2);
        expect(uploadImageAttachment).toHaveBeenCalledTimes(1);
    });
});
