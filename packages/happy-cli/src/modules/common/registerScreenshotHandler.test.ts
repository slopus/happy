import { describe, it, expect, vi } from 'vitest';
import { registerScreenshotHandler } from './registerScreenshotHandler';

// 假的 rpc 管理器：把 handler 收进 Map，call 时直接调用，避免真截屏 / 真网络
function fakeRpc() {
    const handlers = new Map<string, Function>();
    return {
        registerHandler: (m: string, h: Function) => handlers.set(m, h),
        call: (m: string, p: any) => handlers.get(m)!(p),
    };
}

describe('registerScreenshotHandler', () => {
    it('captures the full desktop without accepting target configuration', async () => {
        const rpc = fakeRpc();
        const capture = vi.fn(async () => ({ path: '/tmp/x.jpg' }));
        registerScreenshotHandler(rpc as any, {
            capture,
            readBase64: async () => 'AAA',
            removeFile: async () => {},
        });
        const res = await rpc.call('screenshot', {});
        expect(res.success).toBe(true);
        expect(res.dataBase64).toBe('AAA');
        expect(res.mimeType).toBe('image/jpeg');
        expect(res).not.toHaveProperty('targetUsed');
        expect(capture).toHaveBeenCalledWith();
    });

    it('reports PNG when compression falls back to the original capture', async () => {
        const rpc = fakeRpc();
        registerScreenshotHandler(rpc as any, {
            capture: async () => ({ path: '/tmp/x.png' }),
            readBase64: async () => 'AAA',
            removeFile: async () => {},
        });

        const res = await rpc.call('screenshot', {});

        expect(res.mimeType).toBe('image/png');
    });

    it('截图失败：success=false + error 包含原始信息', async () => {
        const rpc = fakeRpc();
        registerScreenshotHandler(rpc as any, {
            capture: async () => { throw new Error('boom'); },
            readBase64: async () => '',
            removeFile: async () => {},
        });
        const res = await rpc.call('screenshot', {});
        expect(res.success).toBe(false);
        expect(res.error).toContain('boom');
    });

    it('读完 base64 后删除临时文件（清理泄漏）', async () => {
        const rpc = fakeRpc();
        const removeFile = vi.fn(async () => {});
        registerScreenshotHandler(rpc as any, {
            capture: async () => ({ path: '/tmp/happy-shot-123.jpg' }),
            readBase64: async () => 'AAA',
            removeFile,
        });
        const res = await rpc.call('screenshot', {});
        expect(res.success).toBe(true);
        // 读完 base64 必须把这个临时文件删掉，避免堆积
        expect(removeFile).toHaveBeenCalledTimes(1);
        expect(removeFile).toHaveBeenCalledWith('/tmp/happy-shot-123.jpg');
    });

    it('readBase64 抛错也要删除临时文件（try/finally 保证）', async () => {
        const rpc = fakeRpc();
        const removeFile = vi.fn(async () => {});
        registerScreenshotHandler(rpc as any, {
            capture: async () => ({ path: '/tmp/happy-shot-456.jpg' }),
            readBase64: async () => { throw new Error('read fail'); },
            removeFile,
        });
        const res = await rpc.call('screenshot', {});
        // 读失败走 catch → success=false，但临时文件仍必须被清理
        expect(res.success).toBe(false);
        expect(removeFile).toHaveBeenCalledTimes(1);
        expect(removeFile).toHaveBeenCalledWith('/tmp/happy-shot-456.jpg');
    });
});
