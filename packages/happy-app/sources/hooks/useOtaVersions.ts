import * as React from 'react';
import {
    extractOtaKeys,
    listOtaStamps,
    type OtaVersion,
} from '@/utils/otaVersions';
import otaRuntimeVersions from '../../ota-runtime-versions.json';

export type { OtaVersion };

// useOtaVersions —— 拉取自建 OSS 上某频道的全部 OTA 历史版本，供「OTA 版本」选择器展示。
//
// 数据来源：发布脚本 publish-ota.js 每次发布都会在 OSS 写一份轻量元信息
//   meta/<platform>/<runtime>/<channel>/<stamp>.json = { stamp, createdAt, id, channel, git, display }
// 这里分两步：
//   1) 对桶做 ListObjectsV2（GET ?list-type=2&prefix=meta/.../<channel>/）拿到全部 key；
//      OSS 返回 XML，用正则提取 <Key> 即可（受控格式，无需引 XML 解析库）。
//   2) 并发 fetch 每个 meta json，组装成版本列表（按 stamp 倒序，最新在前）。
// 需要桶对 meta/ 前缀开匿名 ListObjects + GetObject 权限（见部署文档）。

const OSS_PUBLIC_BASE = 'https://happy-app-ota-jacky.oss-cn-hangzhou.aliyuncs.com';
const PAGE_SIZE = 20;
export const PREVIEW_OTA_RUNTIME_VERSION = otaRuntimeVersions.preview;
export const PRODUCTION_OTA_RUNTIME_VERSION = otaRuntimeVersions.production;
export const DEFAULT_OTA_RUNTIME_VERSION = PREVIEW_OTA_RUNTIME_VERSION;

export function getDefaultOtaRuntimeVersion(channel: string | null | undefined): string {
    return channel === 'production' ? PRODUCTION_OTA_RUNTIME_VERSION : PREVIEW_OTA_RUNTIME_VERSION;
}

export interface OtaVersionsState {
    versions: OtaVersion[];
    loading: boolean;
    loadingMore: boolean;
    hasMore: boolean;
    loadedCount: number;
    totalCount: number;
    error: string | null;
    debug: string; // 诊断信息（HTTP 状态 / 字节数 / 解析结果），排查「拿不到版本」用
    refresh: () => Promise<void>;
    loadMore: () => Promise<void>;
}

export interface OtaVersionDetailState {
    version: OtaVersion | null;
    loading: boolean;
    error: string | null;
    refresh: () => Promise<void>;
}

async function fetchOtaVersionMeta(channel: string, platform: string, runtime: string, stamp: string): Promise<OtaVersion | null> {
    try {
        const prefix = `meta/${platform}/${runtime}/${channel}/`;
        const res = await fetch(`${OSS_PUBLIC_BASE}/${prefix}${stamp}.json`);
        if (!res.ok) return null;
        const meta = await res.json();
        return {
            stamp,
            id: meta.id ?? '',
            createdAt: meta.createdAt ?? '',
            channel: meta.channel ?? channel,
            git: meta.git ?? {},
            display: meta.display ?? undefined,
        } as OtaVersion;
    } catch {
        return null;
    }
}

async function fetchOtaVersionBatch(channel: string, platform: string, runtime: string, stamps: string[]): Promise<OtaVersion[]> {
    const metas = await Promise.all(stamps.map((stamp) => fetchOtaVersionMeta(channel, platform, runtime, stamp)));
    return metas.filter((version): version is OtaVersion => version !== null);
}

export async function fetchOtaVersion(channel: string, stamp: string, platform: string = 'android', runtime: string = getDefaultOtaRuntimeVersion(channel)): Promise<OtaVersion | null> {
    return fetchOtaVersionMeta(channel, platform, runtime, stamp);
}

export function useOtaVersion(stamp: string | null, channel: string = 'preview', platform: string = 'android', runtime: string = getDefaultOtaRuntimeVersion(channel)): OtaVersionDetailState {
    const [version, setVersion] = React.useState<OtaVersion | null>(null);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);
    const requestIdRef = React.useRef(0);

    const refresh = React.useCallback(async () => {
        const requestId = ++requestIdRef.current;
        if (!stamp) {
            setVersion(null);
            setError('缺少 OTA 版本参数');
            setLoading(false);
            return;
        }

        setLoading(true);
        setError(null);
        try {
            const nextVersion = await fetchOtaVersionMeta(channel, platform, runtime, stamp);
            if (requestId !== requestIdRef.current) return;
            if (!nextVersion) {
                setVersion(null);
                setError('找不到这个 OTA 版本');
                return;
            }
            setVersion(nextVersion);
        } catch (e) {
            if (requestId !== requestIdRef.current) return;
            setVersion(null);
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            if (requestId === requestIdRef.current) {
                setLoading(false);
            }
        }
    }, [channel, platform, runtime, stamp]);

    React.useEffect(() => {
        refresh();
    }, [refresh]);

    return { version, loading, error, refresh };
}

export function useOtaVersions(channel: string = 'preview', platform: string = 'android', runtime: string = getDefaultOtaRuntimeVersion(channel)): OtaVersionsState {
    const [versions, setVersions] = React.useState<OtaVersion[]>([]);
    const [loading, setLoading] = React.useState(true);
    const [loadingMore, setLoadingMore] = React.useState(false);
    const [hasMore, setHasMore] = React.useState(false);
    const [loadedCount, setLoadedCount] = React.useState(0);
    const [totalCount, setTotalCount] = React.useState(0);
    const [error, setError] = React.useState<string | null>(null);
    const [debug, setDebug] = React.useState<string>('');
    const requestIdRef = React.useRef(0);
    const allStampsRef = React.useRef<string[]>([]);
    const listDebugRef = React.useRef('');

    const updateDebug = React.useCallback((renderedCount: number, message?: string) => {
        const base = listDebugRef.current;
        const loadInfo = totalCount > 0 ? ` · loaded ${loadedCount}/${totalCount} · rendered ${renderedCount}` : '';
        const extra = message ? ` · ${message}` : '';
        setDebug(`${base}${loadInfo}${extra}`.trim());
    }, [loadedCount, totalCount]);

    const refresh = React.useCallback(async () => {
        const requestId = ++requestIdRef.current;
        setLoading(true);
        setLoadingMore(false);
        setError(null);
        try {
            const prefix = `meta/${platform}/${runtime}/${channel}/`;
            const listUrl = `${OSS_PUBLIC_BASE}/?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=1000`;
            const listRes = await fetch(listUrl);
            const xml = await listRes.text();
            const allKeys = extractOtaKeys(xml);
            const stamps = listOtaStamps(allKeys, prefix);
            const initialStamps = stamps.slice(0, PAGE_SIZE);
            listDebugRef.current = `HTTP ${listRes.status} · ${xml.length}B · keys ${allKeys.length} · stamps ${stamps.length} · head「${xml.slice(0, 40).replace(/\s+/g, ' ')}」`;

            if (!listRes.ok) {
                throw new Error(`ListObjects HTTP ${listRes.status}: ${xml.slice(0, 120)}`);
            }

            const ok = await fetchOtaVersionBatch(channel, platform, runtime, initialStamps);
            if (requestId !== requestIdRef.current) return;

            allStampsRef.current = stamps;
            setVersions(ok);
            setTotalCount(stamps.length);
            setLoadedCount(initialStamps.length);
            setHasMore(stamps.length > initialStamps.length);
            setDebug(`${listDebugRef.current} · loaded ${initialStamps.length}/${stamps.length} · rendered ${ok.length}`.trim());
        } catch (e) {
            if (requestId !== requestIdRef.current) return;
            const msg = e instanceof Error ? e.message : String(e);
            setError(msg);
            setDebug((d) => `${d || ''} · ERR ${msg}`.slice(0, 300));
            setVersions([]);
            setHasMore(false);
            setLoadedCount(0);
            setTotalCount(0);
        } finally {
            if (requestId === requestIdRef.current) {
                setLoading(false);
            }
        }
    }, [channel, platform, runtime]);

    const loadMore = React.useCallback(async () => {
        if (loading || loadingMore || !hasMore) return;

        const requestId = requestIdRef.current;
        const start = loadedCount;
        const nextStamps = allStampsRef.current.slice(start, start + PAGE_SIZE);
        if (nextStamps.length === 0) {
            setHasMore(false);
            return;
        }

        setLoadingMore(true);
        setError(null);
        try {
            const more = await fetchOtaVersionBatch(channel, platform, runtime, nextStamps);
            if (requestId !== requestIdRef.current) return;

            const nextLoadedCount = start + nextStamps.length;
            setVersions((current) => [...current, ...more]);
            setLoadedCount(nextLoadedCount);
            setHasMore(allStampsRef.current.length > nextLoadedCount);
            setDebug(`${listDebugRef.current} · loaded ${nextLoadedCount}/${allStampsRef.current.length} · rendered ${versions.length + more.length}`.trim());
        } catch (e) {
            if (requestId !== requestIdRef.current) return;
            const msg = e instanceof Error ? e.message : String(e);
            setError(msg);
            updateDebug(versions.length, `ERR ${msg}`);
        } finally {
            if (requestId === requestIdRef.current) {
                setLoadingMore(false);
            }
        }
    }, [channel, hasMore, loadedCount, loading, loadingMore, platform, runtime, updateDebug, versions.length]);

    React.useEffect(() => {
        refresh();
    }, [refresh]);

    return { versions, loading, loadingMore, hasMore, loadedCount, totalCount, error, debug, refresh, loadMore };
}
