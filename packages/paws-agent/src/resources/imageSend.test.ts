import { createHmac } from 'node:crypto';
import nacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeBase64, decrypt } from '../crypto/encryption';
import { RecordEncryptionStore } from '../crypto/records';
import { PawsHttpTransport } from '../transport/http';
import { MessagesResourceImpl } from './messages';

const key = Uint8Array.from({ length: 32 }, (_, i) => i);
const image = { name: '截图.png', mimeType: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]), width: 2, height: 3 };
const slot = { ref: 'sessions/s1/attachments/a.enc', uploadUrl: 'https://storage.example/upload', method: 'POST', formFields: { key: 'a.enc', policy: 'signed' } };

function setup(variant: 'legacy' | 'dataKey' = 'legacy', descriptor: unknown = slot) {
    const encryption = new RecordEncryptionStore();
    encryption.setSession('s1', { key, variant });
    const post = vi.fn(async (url: string, body: unknown) => ({ data: url.endsWith('request-upload') ? descriptor : body }));
    const transport = new PawsHttpTransport({
        serverUrl: 'https://paws.example',
        credentials: { getCredentials: async () => ({ token: 'private-token', secret: key, contentKeyPair: { publicKey: key, secretKey: key } }) } as never,
        client: { post } as never,
    });
    const sessions = { get: vi.fn().mockResolvedValue({ active: true, metadata: {} }) };
    const messages = new MessagesResourceImpl(transport, sessions as never, encryption);
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    return { messages, post, fetch, sessions, transport };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('加密图片发送', () => {
    it.each(['legacy', 'dataKey'] as const)('%s 会话的附件能由独立接收端解密，且文件事件先于正文', async variant => {
        const { messages, post, fetch } = setup(variant);
        await messages.send({ sessionId: 's1', text: '请看图', localId: 'turn1', images: [image] });
        expect(fetch).toHaveBeenCalledOnce();
        const options = fetch.mock.calls[0][1];
        expect(options.redirect).toBe('manual');
        expect(options.credentials).toBe('omit');
        expect(options.headers?.Authorization).toBeUndefined();
        const form = options.body as FormData;
        expect(form.get('policy')).toBe('signed');
        const bundle = new Uint8Array(await (form.get('file') as Blob).arrayBuffer());
        // 独立复现 CLI 的密钥派生，避免用 SDK 的加密函数验证自身。
        const root = createHmac('sha512', 'Happy Blobs Master Seed').update(key).digest();
        const blobKey = createHmac('sha512', root.subarray(32)).update(Buffer.concat([Buffer.from([0]), Buffer.from(variant === 'legacy' ? 'master' : 'session')])).digest().subarray(0, 32);
        expect(nacl.secretbox.open(bundle.subarray(24), bundle.subarray(0, 24), blobKey)).toEqual(image.bytes);
        expect(post.mock.calls[0][1]).toEqual({ filename: image.name, size: bundle.length });
        const batch = (post.mock.calls[1][1] as { messages: { localId: string; content: string }[] }).messages;
        expect(batch).toHaveLength(2);
        expect(batch[0].localId).toBe('turn1:image:0');
        expect(decrypt(key, variant, decodeBase64(batch[0].content))).toMatchObject({ role: 'session', content: { type: 'session', data: { role: 'user', ev: { t: 'file', ref: slot.ref, name: image.name, mimeType: image.mimeType, size: image.bytes.length, image: { width: 2, height: 3 } } } } });
        expect(decrypt(key, variant, decodeBase64(batch[1].content))).toMatchObject({ role: 'user', content: { type: 'text', text: '请看图' } });
    });

    it('仅图片也以空正文收尾，让 CLI 消费暂存附件并触发这一轮', async () => {
        const { messages, post } = setup();
        const receipt = await messages.send({ sessionId: 's1', text: '', localId: 'image-only', images: [image] });
        const batch = (post.mock.calls.at(-1)![1] as { messages: { localId: string; content: string }[] }).messages;
        expect(batch).toHaveLength(2);
        expect(batch[1].localId).toBe(receipt.localId);
        expect(decrypt(key, 'legacy', decodeBase64(batch[0].content))).toMatchObject({ role: 'session', content: { type: 'session', data: { ev: { t: 'file' } } } });
        expect(decrypt(key, 'legacy', decodeBase64(batch[1].content))).toMatchObject({ role: 'user', content: { type: 'text', text: '' } });
    });

    it.each([302,307,500])('第二张上传返回 %s 时不提交部分附件或正文', async status => {
        const { messages, post, fetch } = setup();
        fetch.mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(new Response(null, { status }));
        await expect(messages.send({ sessionId: 's1', text: '看两张', images: [image, image] })).rejects.toMatchObject({ code: 'UNKNOWN', details: {phase:'attachments',messageSubmitted:false} });
        expect(post.mock.calls.every(([url]) => url.endsWith('request-upload'))).toBe(true);
    });

    it.each([
        [Array(5).fill(image)],
        [[{ ...image, bytes: new Uint8Array() }]],
        [[{ ...image, bytes: new Uint8Array(10 * 1024 * 1024 + 1) }]],
        [[{ ...image, mimeType: 'image/svg+xml' }]],
        [[{ ...image, width: -1 }]],
    ])('无效输入在访问会话或上传前拒绝（用例 %#）', async images => {
        const { messages, post, sessions } = setup();
        await expect(messages.send({ sessionId: 's1', text: '', images })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
        expect(sessions.get).not.toHaveBeenCalled();
        expect(post).not.toHaveBeenCalled();
    });

    it('取消上传后不再提交消息', async () => {
        const { messages, post, fetch } = setup();
        const controller = new AbortController();
        fetch.mockImplementation(async (_url, options) => {
            controller.abort();
            options.signal.throwIfAborted();
        });
        await expect(messages.send({ sessionId: 's1', text: '不要发送', images: [image], signal: controller.signal })).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
        expect(post.mock.calls.every(([url]) => url.endsWith('request-upload'))).toBe(true);
    });

    it('已经取消时不访问会话', async () => {
        const { messages, sessions } = setup();
        await expect(messages.send({ sessionId: 's1', text: '不要发送', signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
        expect(sessions.get).not.toHaveBeenCalled();
    });
});
