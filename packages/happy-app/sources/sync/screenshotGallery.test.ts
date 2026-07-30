import { describe, it, expect, beforeEach, vi } from 'vitest';
import React, { act } from 'react';

// react-test-renderer 没有随包发布 TypeScript 声明。
// @ts-expect-error 测试只使用 create/unmount 所需的最小接口。
import TestRenderer from 'react-test-renderer';

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
}));

// react-native-mmkv 是原生模块，node/vitest 下无法直接 import，用内存 Map 替身。
const store = new Map<string, string>();
vi.mock('react-native-mmkv', () => {
    return {
        MMKV: class {
            getString(key: string): string | undefined {
                return store.get(key);
            }
            set(key: string, value: string): void {
                store.set(key, value);
            }
        },
    };
});

// expo-file-system/legacy 同样是原生模块，本测试不覆盖落盘逻辑，仅做空 mock 防止 import 报错。
vi.mock('expo-file-system/legacy', () => ({
    documentDirectory: null,
    makeDirectoryAsync: vi.fn(),
    getInfoAsync: vi.fn(),
    writeAsStringAsync: vi.fn(),
    EncodingType: { Base64: 'base64' },
}));

const writtenFiles = new Map<string, Blob>();
const screenshotsDirectory = {
    getFileHandle: vi.fn(async (name: string) => ({
        createWritable: async () => ({
            write: async (data: BlobPart) => {
                writtenFiles.set(name, new Blob([data], { type: 'image/png' }));
            },
            close: async () => {},
        }),
        getFile: async () => writtenFiles.get(name),
    })),
};
const opfsRoot = {
    getDirectoryHandle: vi.fn(async () => screenshotsDirectory),
};

vi.stubGlobal('navigator', {
    storage: {
        getDirectory: vi.fn(async () => opfsRoot),
    },
});

import * as screenshotGallery from './screenshotGallery';

const {
    loadGallery,
    addScreenshotEntry,
    hasRemoteId,
    saveBase64Png,
} = screenshotGallery;

beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    store.clear();
    writtenFiles.clear();
});

describe('screenshotGallery', () => {
    it('按 sessionId 隔离：A 会话的图不会出现在 B 会话', () => {
        addScreenshotEntry('sessionA', {
            uri: 'file:///a.png', source: 'manual', target: 'desktop', createdAt: 1000,
        });
        addScreenshotEntry('sessionB', {
            uri: 'file:///b.png', source: 'manual', target: 'desktop', createdAt: 2000,
        });

        const a = loadGallery('sessionA');
        const b = loadGallery('sessionB');
        expect(a).toHaveLength(1);
        expect(b).toHaveLength(1);
        expect(a[0].uri).toBe('file:///a.png');
        expect(b[0].uri).toBe('file:///b.png');
        expect(loadGallery('sessionC')).toEqual([]);
    });

    it('新图排最前（按 createdAt 倒序）', () => {
        addScreenshotEntry('s', { uri: 'file:///old.png', source: 'manual', target: 'desktop', createdAt: 100 });
        addScreenshotEntry('s', { uri: 'file:///new.png', source: 'ai', target: 'browser', createdAt: 300 });
        addScreenshotEntry('s', { uri: 'file:///mid.png', source: 'manual', target: 'desktop', createdAt: 200 });

        const list = loadGallery('s');
        expect(list.map((e) => e.uri)).toEqual([
            'file:///new.png',
            'file:///mid.png',
            'file:///old.png',
        ]);
    });

    it('addScreenshotEntry 返回带唯一 id 的记录', () => {
        const e1 = addScreenshotEntry('s', { uri: 'file:///1.png', source: 'manual', target: 'desktop', createdAt: 1 });
        const e2 = addScreenshotEntry('s', { uri: 'file:///2.png', source: 'manual', target: 'desktop', createdAt: 2 });
        expect(e1.id).toBeTruthy();
        expect(e2.id).toBeTruthy();
        expect(e1.id).not.toBe(e2.id);
    });

    it('hasRemoteId 命中与不命中', () => {
        addScreenshotEntry('s', {
            uri: 'file:///r.png', source: 'ai', target: 'browser', remoteId: 'remote-1', createdAt: 1,
        });
        expect(hasRemoteId('s', 'remote-1')).toBe(true);
        expect(hasRemoteId('s', 'remote-x')).toBe(false);
        // 隔离：另一个会话即便有同名 remoteId 也不串
        expect(hasRemoteId('other', 'remote-1')).toBe(false);
    });

    it('PC Web 在 documentDirectory 不可用时把 PNG 保存到浏览器持久化目录', async () => {
        const uri = await saveBase64Png('iVBORw0KGgo=');

        expect(uri).toMatch(/^paws-screenshot:\/\/local\/.+\.png$/);
        expect(opfsRoot.getDirectoryHandle).toHaveBeenCalledWith('screenshots', { create: true });
        expect(writtenFiles).toHaveLength(1);
        const [file] = [...writtenFiles.values()];
        expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    });

    it('从持久化 URI 恢复为可展示和上传的 blob URI', async () => {
        const uri = await saveBase64Png('iVBORw0KGgo=');
        const resolveScreenshotUri = (
            screenshotGallery as typeof screenshotGallery & {
                resolveScreenshotUri?: (persistentUri: string) => Promise<string>;
            }
        ).resolveScreenshotUri;

        expect(resolveScreenshotUri).toBeTypeOf('function');
        if (!resolveScreenshotUri) {
            return;
        }

        const resolvedUri = await resolveScreenshotUri(uri);
        expect(resolvedUri).toMatch(/^blob:/);
        const bytes = new Uint8Array(await (await fetch(resolvedUri)).arrayBuffer());
        expect([...bytes]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    });

    it('图库渲染时异步恢复持久化截图 URI', async () => {
        const uri = await saveBase64Png('iVBORw0KGgo=');
        const useResolvedScreenshotUri = (
            screenshotGallery as typeof screenshotGallery & {
                useResolvedScreenshotUri?: (persistentUri: string) => string | null;
            }
        ).useResolvedScreenshotUri;

        expect(useResolvedScreenshotUri).toBeTypeOf('function');
        if (!useResolvedScreenshotUri) {
            return;
        }

        function Probe() {
            const resolvedUri = useResolvedScreenshotUri(uri);
            return React.createElement('probe', { resolvedUri });
        }

        let renderer: ReturnType<typeof TestRenderer.create>;
        await act(async () => {
            renderer = TestRenderer.create(React.createElement(Probe));
        });

        expect(renderer!.root.findByType('probe').props.resolvedUri).toMatch(/^blob:/);

        act(() => renderer!.unmount());
    });
});
