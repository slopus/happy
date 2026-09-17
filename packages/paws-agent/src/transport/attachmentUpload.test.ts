import { afterEach, expect, it, vi } from 'vitest';
import { PawsHttpTransport } from './http';

function setup(serverUrl = 'https://paws.example') {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    const transport = new PawsHttpTransport({ serverUrl, credentials: { getCredentials: async () => ({ token: 'secret' }) } as never });
    return { fetch, transport };
}
const bytes = new Uint8Array([1, 2, 3]);
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it.each(['http://localhost:3005/blob', 'http://127.0.0.1:3005/blob', 'http://[::1]:3005/blob', '/blob'])('本地上传地址 %s 被规范化到服务器且携带认证', async uploadUrl => {
    const { transport, fetch } = setup();
    await transport.uploadAttachment({ ref: 'a.enc', uploadUrl, method: 'PUT' }, bytes);
    expect(fetch).toHaveBeenCalledWith('https://paws.example/blob', expect.objectContaining({ method: 'PUT', headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/octet-stream' }, redirect: 'manual', credentials: 'omit' }));
});

it('相似前缀的第三方 PUT 不能收到 Paws token', async () => {
    const { transport, fetch } = setup();
    await transport.uploadAttachment({ ref: 'a.enc', uploadUrl: 'https://paws.example.evil.test/blob', method: 'PUT' }, bytes);
    expect(fetch.mock.calls[0][1].headers.Authorization).toBeUndefined();
});

it.each([
    { ref: 'a', uploadUrl: 'http://storage.example/blob', method: 'PUT' },
    { ref: 'a', uploadUrl: 'ftp://storage.example/blob', method: 'PUT' },
    { ref: 'a', uploadUrl: 'https://user:password@storage.example/blob', method: 'PUT' },
    { ref: 'a', uploadUrl: 'https://storage.example/blob', method: 'DELETE' },
    { ref: '', uploadUrl: 'https://storage.example/blob', method: 'PUT' },
    { ref: 'a', uploadUrl: 'https://storage.example/blob', method: 'POST', formFields: { policy: 123 } },
    null,
])('拒绝不安全或损坏的上传描述符 %j', async descriptor => {
    const { transport, fetch } = setup();
    await expect(transport.uploadAttachment(descriptor, bytes)).rejects.toMatchObject({ code: 'PROTOCOL_UNSUPPORTED' });
    expect(fetch).not.toHaveBeenCalled();
});

it('主动取消、客户端销毁和超时都会中断上传', async () => {
    vi.useFakeTimers();
    for (const reason of ['abort', 'dispose', 'timeout']) {
        const { transport, fetch } = setup();
        const controller = new AbortController();
        fetch.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(options.signal.reason));
        }));
        const task = transport.uploadAttachment({ ref: 'a', uploadUrl: 'https://storage.example/blob', method: 'PUT' }, bytes, { signal: controller.signal });
        const result = expect(task).rejects.toMatchObject({ code: reason === 'timeout' ? 'RPC_TIMEOUT' : 'CONNECTION_LOST' });
        await vi.advanceTimersByTimeAsync(0);
        expect(fetch).toHaveBeenCalledOnce();
        if (reason === 'abort') controller.abort();
        if (reason === 'dispose') transport.dispose();
        if (reason === 'timeout') await vi.advanceTimersByTimeAsync(15_000);
        await result;
    }
});

it('post 将发送取消信号传到底层，取消后不继续请求', async () => {
    const controller = new AbortController();
    const post = vi.fn(async (_url, _body, options) => {
        controller.abort();
        options.signal.throwIfAborted();
    });
    const transport = new PawsHttpTransport({ serverUrl: 'https://paws.example', credentials: { getCredentials: async () => ({ token: 'secret' }) } as never, client: { post } as never });
    await expect(transport.post('/messages', {}, { signal: controller.signal })).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
});
