import * as React from 'react';
import { Platform } from 'react-native';
import { MMKV, useMMKVString } from 'react-native-mmkv';
import {
    documentDirectory,
    makeDirectoryAsync,
    getInfoAsync,
    writeAsStringAsync,
    EncodingType,
} from 'expo-file-system/legacy';
import { decodeBase64 } from '@/encryption/base64';

const mmkv = new MMKV();
const KEY = 'screenshot-gallery-v1';
const WEB_SCREENSHOT_URI_PREFIX = 'paws-screenshot://local/';
const WEB_SCREENSHOT_DIRECTORY = 'screenshots';
const resolvedWebScreenshotUris = new Map<string, string>();
/** 每个会话「上次打开图库抽屉时见到的最新 createdAt」，用于红点判断。 */
const LAST_SEEN_KEY = 'screenshot-gallery-last-seen-v1';

/**
 * 单条截图记录。base64 PNG 落盘后只保留持久化本地 URI，避免 MMKV/localStorage 堆大块 base64。
 */
export interface ScreenshotEntry {
    id: string;
    uri: string;                 // 原生 file:// 或 Web paws-screenshot:// 持久化 URI
    source: 'manual' | 'ai';
    target: 'desktop' | 'browser';
    note?: string;
    remoteId?: string;           // CLI 临时缓存里的 id（AI 路径懒拉取去重用）
    createdAt: number;
}

/** 全部会话的图库：sessionId -> 该会话的截图列表 */
type AllGalleries = Record<string, ScreenshotEntry[]>;

// ============ 纯函数（不依赖 MMKV，便于单测）============

/** 按 createdAt 倒序（新图在前）。返回新数组，不修改入参。 */
function sortDesc(entries: ScreenshotEntry[]): ScreenshotEntry[] {
    return [...entries].sort((a, b) => b.createdAt - a.createdAt);
}

/** 把一条记录插入到某会话列表，返回新的全量图库（不修改入参）。 */
function upsert(all: AllGalleries, sessionId: string, entry: ScreenshotEntry): AllGalleries {
    const prev = all[sessionId] ?? [];
    return {
        ...all,
        [sessionId]: [...prev, entry],
    };
}

// ============ MMKV 读写（薄包装）============

/** 读全部图库；解析失败时退回空对象（永不抛错）。 */
function readAll(): AllGalleries {
    const raw = mmkv.getString(KEY);
    if (!raw) {
        return {};
    }
    try {
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed === 'object') ? parsed as AllGalleries : {};
    } catch (e) {
        console.error('Failed to parse screenshot gallery', e);
        return {};
    }
}

/** 写回全部图库。 */
function writeAll(all: AllGalleries): void {
    mmkv.set(KEY, JSON.stringify(all));
}

// ============ 对外 API ============

/** 读取某会话的截图列表，按 createdAt 倒序（新图在前）。 */
export function loadGallery(sessionId: string): ScreenshotEntry[] {
    const all = readAll();
    return sortDesc(all[sessionId] ?? []);
}

/** 生成稳定唯一 id 并把一条记录入库，返回带 id 的完整记录。 */
export function addScreenshotEntry(sessionId: string, entry: Omit<ScreenshotEntry, 'id'>): ScreenshotEntry {
    const id = `${entry.createdAt}_${Math.random().toString(36).slice(2, 10)}`;
    const full: ScreenshotEntry = { ...entry, id };
    const all = readAll();
    writeAll(upsert(all, sessionId, full));
    return full;
}

/** 该会话是否已存在某 remoteId 的记录（Task 3.1 懒拉取去重用）。 */
export function hasRemoteId(sessionId: string, remoteId: string): boolean {
    const all = readAll();
    const list = all[sessionId] ?? [];
    return list.some((e) => e.remoteId === remoteId);
}

// ============ 红点（未读新图）状态 ============

/** 读取某会话「上次见到的最新 createdAt」，从未打开过返回 0。 */
export function getLastSeen(sessionId: string): number {
    const raw = mmkv.getString(LAST_SEEN_KEY);
    if (!raw) {
        return 0;
    }
    try {
        const parsed = JSON.parse(raw) as Record<string, number>;
        return (parsed && typeof parsed === 'object' && typeof parsed[sessionId] === 'number')
            ? parsed[sessionId]
            : 0;
    } catch {
        return 0;
    }
}

/** 记录某会话「已见到的最新 createdAt」（打开抽屉时调用，清除红点）。 */
export function setLastSeen(sessionId: string, createdAt: number): void {
    let parsed: Record<string, number> = {};
    const raw = mmkv.getString(LAST_SEEN_KEY);
    if (raw) {
        try {
            const obj = JSON.parse(raw);
            if (obj && typeof obj === 'object') {
                parsed = obj;
            }
        } catch {
            // 解析失败时退回空对象
        }
    }
    parsed[sessionId] = createdAt;
    mmkv.set(LAST_SEEN_KEY, JSON.stringify(parsed));
}

// ============ React hooks（响应式）============

/**
 * 响应式读取某会话的截图列表（倒序）。监听 MMKV 的 gallery key，
 * AI/手动截图写入后抽屉里自动出现新图，无需手动刷新。
 */
export function useGallery(sessionId: string): ScreenshotEntry[] {
    const [raw] = useMMKVString(KEY, mmkv);
    return React.useMemo(() => {
        if (!raw) {
            return [];
        }
        try {
            const parsed = JSON.parse(raw) as AllGalleries;
            return sortDesc(parsed?.[sessionId] ?? []);
        } catch {
            return [];
        }
    }, [raw, sessionId]);
}

/**
 * 响应式判断某会话是否有「未查看的新截图」——即图库里存在比 lastSeen 更新的条目。
 * 监听 gallery key，新图写入即变 true；调用方在打开抽屉时 setLastSeen 后回落 false。
 * 第二返回值是当前图库最新 createdAt（打开抽屉时传给 setLastSeen 用）。
 */
export function useHasNewScreenshots(sessionId: string): { hasNew: boolean; latestCreatedAt: number } {
    const list = useGallery(sessionId);
    const [lastSeenRaw] = useMMKVString(LAST_SEEN_KEY, mmkv);
    return React.useMemo(() => {
        const latestCreatedAt = list.length > 0 ? list[0].createdAt : 0;
        let lastSeen = 0;
        if (lastSeenRaw) {
            try {
                const parsed = JSON.parse(lastSeenRaw) as Record<string, number>;
                if (parsed && typeof parsed === 'object' && typeof parsed[sessionId] === 'number') {
                    lastSeen = parsed[sessionId];
                }
            } catch {
                lastSeen = 0;
            }
        }
        return { hasNew: latestCreatedAt > lastSeen, latestCreatedAt };
    }, [list, lastSeenRaw, sessionId]);
}

/**
 * 将图库记录里的持久化 URI 恢复为 Image/fetch 可消费的运行时 URI。
 * 原生 file:// 路径同步可用；Web OPFS 路径在 effect 中恢复为 blob: URL。
 */
export function useResolvedScreenshotUri(uri: string): string | null {
    const isWebPersistentUri = Platform.OS === 'web' && uri.startsWith(WEB_SCREENSHOT_URI_PREFIX);
    const [resolvedUri, setResolvedUri] = React.useState<string | null>(
        isWebPersistentUri ? null : uri,
    );

    React.useEffect(() => {
        let cancelled = false;
        if (!isWebPersistentUri) {
            setResolvedUri(uri);
            return () => {
                cancelled = true;
            };
        }

        setResolvedUri(null);
        void resolveScreenshotUri(uri)
            .then((nextUri) => {
                if (!cancelled) {
                    setResolvedUri(nextUri);
                }
            })
            .catch((error) => {
                console.warn('[screenshotGallery] Failed to restore screenshot URI', error);
            });

        return () => {
            cancelled = true;
        };
    }, [isWebPersistentUri, uri]);

    return resolvedUri;
}

// ============ base64 落盘与持久化 URI 恢复 ============

/**
 * 把 base64 PNG 写入平台持久化目录：
 * - PC/Web 使用浏览器 Origin Private File System，避免把大块 base64 塞进 localStorage。
 * - 原生端继续使用 documentDirectory/screenshots。
 */
export async function saveBase64Png(base64: string): Promise<string> {
    const fileId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const fileName = `${fileId}.png`;

    if (Platform.OS === 'web') {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle(WEB_SCREENSHOT_DIRECTORY, { create: true });
        const file = await dir.getFileHandle(fileName, { create: true });
        const writable = await file.createWritable();
        try {
            const decoded = decodeBase64(base64);
            const bytes = new ArrayBuffer(decoded.byteLength);
            new Uint8Array(bytes).set(decoded);
            await writable.write(bytes);
        } finally {
            await writable.close();
        }
        return `${WEB_SCREENSHOT_URI_PREFIX}${fileName}`;
    }

    if (!documentDirectory) {
        throw new Error('documentDirectory 不可用，无法保存截图');
    }
    const dir = `${documentDirectory}screenshots/`;
    const info = await getInfoAsync(dir);
    if (!info.exists) {
        await makeDirectoryAsync(dir, { intermediates: true });
    }
    const uri = `${dir}${fileName}`;
    await writeAsStringAsync(uri, base64, { encoding: EncodingType.Base64 });
    return uri;
}

/**
 * 将持久化截图 URI 转为当前运行时可消费的 URI。
 * Web 的 OPFS 文件需要恢复成 blob: URL；原生 file:// URI 原样返回。
 */
export async function resolveScreenshotUri(uri: string): Promise<string> {
    if (Platform.OS !== 'web' || !uri.startsWith(WEB_SCREENSHOT_URI_PREFIX)) {
        return uri;
    }

    const cached = resolvedWebScreenshotUris.get(uri);
    if (cached) {
        return cached;
    }

    const fileName = uri.slice(WEB_SCREENSHOT_URI_PREFIX.length);
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(WEB_SCREENSHOT_DIRECTORY);
    const fileHandle = await dir.getFileHandle(fileName);
    const file = await fileHandle.getFile();
    const objectUri = URL.createObjectURL(file);
    resolvedWebScreenshotUris.set(uri, objectUri);
    return objectUri;
}
