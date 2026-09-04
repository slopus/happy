import { promises as fs } from 'fs';
import { logger } from '@/ui/logger';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { captureScreenshot } from '@/utils/screenshot';

// 手动截屏 RPC：App 点截屏按钮 → sessionRPC 调本方法 → CLI 返回实际格式的 base64 图片
export type ScreenshotRequest = Record<string, never>;

export interface ScreenshotResponse {
    success: boolean;
    dataBase64?: string;
    mimeType?: string;
    error?: string;
}

// 依赖注入：默认接真截图 + 读文件 + 删文件，测试时可替换避免真截屏 / 真删文件
interface Deps {
    capture: () => Promise<{ path: string }>;
    readBase64: (p: string) => Promise<string>;
    removeFile: (p: string) => Promise<void>;
}

const defaultDeps: Deps = {
    capture: captureScreenshot,
    readBase64: (p) => fs.readFile(p, 'base64'),
    // 删除临时截图文件；失败静默（force 忽略「文件不存在」），不影响 RPC 结果
    removeFile: (p) => fs.rm(p, { force: true }).catch(() => {}),
};

/**
 * 注册名为 'screenshot' 的 RPC handler。
 * 无配置入参，始终截取整屏。
 */
export function registerScreenshotHandler(
    rpcHandlerManager: RpcHandlerManager,
    deps: Deps = defaultDeps,
) {
    rpcHandlerManager.registerHandler<ScreenshotRequest, ScreenshotResponse>('screenshot', async () => {
        logger.debug('Screenshot request: full desktop');
        try {
            const { path: filePath } = await deps.capture();
            // 读完 base64 就把这个临时截图文件删掉，避免在 tmpdir 堆积（成功/失败路径都删）。
            // 用 try/finally 保证即便 readBase64 抛错也会清理。删除失败静默，不影响主流程。
            let dataBase64: string;
            try {
                dataBase64 = await deps.readBase64(filePath);
            } finally {
                await deps.removeFile(filePath);
            }
            const mimeType = filePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
            return { success: true, dataBase64, mimeType };
        } catch (error) {
            logger.debug('Failed to capture screenshot:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
}
