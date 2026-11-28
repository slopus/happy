import { expect, it, vi } from 'vitest';
import { decodeBase64, decrypt, encodeBase64, encrypt, getRandomBytes } from '../encryption';
import { RpcHandlerManager } from './RpcHandlerManager';

it.each(['legacy', 'dataKey'] as const)('%s only dispatches authenticated RPC params', async variant => {
    const key = getRandomBytes(32);
    const manager = new RpcHandlerManager({ scopePrefix: 'test', encryptionKey: key, encryptionVariant: variant, logger: vi.fn() });
    const handler = vi.fn(() => 'ok');
    manager.registerHandler('check', handler);
    const call = async (params: string) => decrypt(key, variant, decodeBase64(await manager.handleRequest({ method: 'test:check', params })));

    for (const input of ['', encodeBase64(encrypt(getRandomBytes(32), variant, {}))]) {
        expect(await call(input)).toHaveProperty('error');
        expect(handler).not.toHaveBeenCalled();
    }
    for (const params of [{}, { value: 'hello' }]) {
        expect(await call(encodeBase64(encrypt(key, variant, params)))).toBe('ok');
        expect(handler).toHaveBeenLastCalledWith(params);
    }
});