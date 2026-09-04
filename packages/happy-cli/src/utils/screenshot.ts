import { spawn } from 'child_process';
import { rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { logger } from '@/ui/logger';

/** macOS full-desktop capture arguments. */
export function buildScreencaptureArgs(outPath: string): string[] {
    return ['-x', outPath];
}

export interface SipsOpts {
    maxDim?: number;
    quality?: number;
}

/** Resize the screenshot and convert it to JPEG so the RPC stays below the socket limit. */
export function buildSipsArgs(
    inPath: string,
    outPath: string,
    opts?: SipsOpts,
): string[] {
    const maxDim = opts?.maxDim ?? 1600;
    const quality = opts?.quality ?? 70;
    return [
        '-Z', String(maxDim),
        '-s', 'format', 'jpeg',
        '-s', 'formatOptions', String(quality),
        inPath,
        '--out', outPath,
    ];
}

export interface CaptureDeps {
    runScreencapture: (args: string[]) => Promise<void>;
    runSips: (args: string[]) => Promise<void>;
}

const defaultCaptureDeps: CaptureDeps = { runScreencapture, runSips };

export interface CaptureResult {
    path: string;
}

/** Capture the full macOS desktop, then compress it for transport. */
export async function captureScreenshot(
    deps: CaptureDeps = defaultCaptureDeps,
): Promise<CaptureResult> {
    if (process.platform !== 'darwin') {
        throw new Error(`截图当前仅支持 macOS，检测到平台 ${process.platform}（Linux/Windows 待支持）`);
    }

    const stamp = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    const outPath = join(tmpdir(), `happy-shot-${stamp}.png`);
    await deps.runScreencapture(buildScreencaptureArgs(outPath));

    const jpegPath = join(tmpdir(), `happy-shot-${stamp}.jpg`);
    try {
        await deps.runSips(buildSipsArgs(outPath, jpegPath));
        await rm(outPath, { force: true }).catch(() => {});
        return { path: jpegPath };
    } catch (error) {
        logger.debug('[screenshot] sips 压缩失败，回退返回原 PNG:', error);
        return { path: outPath };
    }
}

async function runScreencapture(args: string[]): Promise<void> {
    return await new Promise<void>((resolve, reject) => {
        const child = spawn('screencapture', args, { stdio: 'ignore' });
        child.on('error', reject);
        child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`screencapture 退出码 ${code}`)));
    });
}

async function runSips(args: string[]): Promise<void> {
    return await new Promise<void>((resolve, reject) => {
        const child = spawn('sips', args, { stdio: 'ignore' });
        child.on('error', reject);
        child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`sips 退出码 ${code}`)));
    });
}
