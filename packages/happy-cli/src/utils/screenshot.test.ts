import { describe, expect, it, vi } from 'vitest';
import { access, rm, writeFile } from 'fs/promises';
import { buildScreencaptureArgs, buildSipsArgs, captureScreenshot } from './screenshot';

async function exists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

describe('buildScreencaptureArgs', () => {
    it('builds a silent full-desktop capture with no target options', () => {
        expect(buildScreencaptureArgs('/tmp/a.png')).toEqual(['-x', '/tmp/a.png']);
    });
});

describe('buildSipsArgs', () => {
    it('uses the transport-safe defaults', () => {
        expect(buildSipsArgs('/tmp/in.png', '/tmp/out.jpg'))
            .toEqual(['-Z', '1600', '-s', 'format', 'jpeg', '-s', 'formatOptions', '70', '/tmp/in.png', '--out', '/tmp/out.jpg']);
    });

    it('accepts explicit resize and quality values', () => {
        expect(buildSipsArgs('/tmp/in.png', '/tmp/out.jpg', { maxDim: 800, quality: 40 }))
            .toEqual(['-Z', '800', '-s', 'format', 'jpeg', '-s', 'formatOptions', '40', '/tmp/in.png', '--out', '/tmp/out.jpg']);
    });
});

describe('captureScreenshot', () => {
    const onDarwin = process.platform === 'darwin' ? it : it.skip;

    onDarwin('captures only the full desktop and returns the compressed JPEG', async () => {
        const runScreencapture = vi.fn(async (_args: string[]) => {});
        const runSips = vi.fn(async (_args: string[]) => {});

        const result = await captureScreenshot({ runScreencapture, runSips });

        expect(runScreencapture).toHaveBeenCalledOnce();
        expect(runScreencapture.mock.calls[0][0][0]).toBe('-x');
        expect(runScreencapture.mock.calls[0][0]).not.toContain('-R');
        expect(runScreencapture.mock.calls[0][0]).not.toContain('-l');
        expect(runSips).toHaveBeenCalledOnce();
        expect(result.path.endsWith('.jpg')).toBe(true);
    });

    onDarwin('removes the intermediate PNG after successful compression', async () => {
        let pngPath = '';
        const runScreencapture = vi.fn(async (args: string[]) => {
            pngPath = args.at(-1)!;
            await writeFile(pngPath, 'fake-png');
        });
        const runSips = vi.fn(async (_args: string[]) => {});

        await captureScreenshot({ runScreencapture, runSips });

        expect(await exists(pngPath)).toBe(false);
    });

    onDarwin('returns and preserves the PNG when compression fails', async () => {
        let pngPath = '';
        const runScreencapture = vi.fn(async (args: string[]) => {
            pngPath = args.at(-1)!;
            await writeFile(pngPath, 'fake-png');
        });
        const runSips = vi.fn(async (_args: string[]) => { throw new Error('sips boom'); });

        const result = await captureScreenshot({ runScreencapture, runSips });

        expect(result.path).toBe(pngPath);
        expect(await exists(pngPath)).toBe(true);
        await rm(pngPath, { force: true });
    });
});
