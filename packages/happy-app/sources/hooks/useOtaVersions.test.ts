import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    DEFAULT_OTA_RUNTIME_VERSION,
    PRODUCTION_OTA_RUNTIME_VERSION,
    PREVIEW_OTA_RUNTIME_VERSION,
    fetchOtaVersion,
    getDefaultOtaRuntimeVersion,
} from './useOtaVersions';

describe('useOtaVersions runtime defaults', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('fetches preview runtime 22 metadata by default', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            json: async () => ({
                id: 'update-id',
                createdAt: '2026-07-10T19:03:08.454Z',
                channel: 'preview',
                git: {},
            }),
        } as Response);

        await expect(fetchOtaVersion('preview', '1783710188454')).resolves.toMatchObject({
            stamp: '1783710188454',
            id: 'update-id',
            channel: 'preview',
        });

        expect(DEFAULT_OTA_RUNTIME_VERSION).toBe('22');
        expect(PREVIEW_OTA_RUNTIME_VERSION).toBe('22');
        expect(PRODUCTION_OTA_RUNTIME_VERSION).toBe('23');
        expect(getDefaultOtaRuntimeVersion('preview')).toBe('22');
        expect(fetchMock).toHaveBeenCalledWith(
            'https://happy-app-ota-jacky.oss-cn-hangzhou.aliyuncs.com/meta/android/22/preview/1783710188454.json',
        );
    });

    it('fetches production runtime 23 metadata by default', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            json: async () => ({
                id: 'prod-update-id',
                createdAt: '2026-07-10T19:03:08.454Z',
                channel: 'production',
                git: {},
            }),
        } as Response);

        await expect(fetchOtaVersion('production', '1783710188454')).resolves.toMatchObject({
            stamp: '1783710188454',
            id: 'prod-update-id',
            channel: 'production',
        });

        expect(getDefaultOtaRuntimeVersion('production')).toBe('23');
        expect(fetchMock).toHaveBeenCalledWith(
            'https://happy-app-ota-jacky.oss-cn-hangzhou.aliyuncs.com/meta/android/23/production/1783710188454.json',
        );
    });
});
