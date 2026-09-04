/**
 * 截屏相关的 session RPC 封装
 * 手动截屏路径：App 端调用 requestScreenshot，内部走 sessionRPC 调 CLI
 */

import { apiSocket } from './apiSocket';

/** CLI 截屏 RPC 的返回结构（与 CLI 端 Task 1.1 约定一致） */
export interface ScreenshotRpcResponse {
    success: boolean;
    dataBase64?: string;
    mimeType?: string;
    error?: string;
}

/**
 * 请求 CLI 截图（手动截屏路径）。
 * @param sessionId 目标会话 id
 */
export async function requestScreenshot(
    sessionId: string,
): Promise<ScreenshotRpcResponse> {
    return apiSocket.sessionRPC<ScreenshotRpcResponse, Record<string, never>>(
        sessionId,
        'screenshot',
        {},
    );
}
