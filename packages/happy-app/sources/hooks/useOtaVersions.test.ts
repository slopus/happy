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

    it('fetches preview runtime 24 metadata by default', async () => {
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

        expect(DEFAULT_OTA_RUNTIME_VERSION).toBe('24');
        expect(PREVIEW_OTA_RUNTIME_VERSION).toBe('24');
        expect(PRODUCTION_OTA_RUNTIME_VERSION).toBe('25');
        expect(getDefaultOtaRuntimeVersion('preview')).toBe('24');
        expect(fetchMock).toHaveBeenCalledWith(
            'https://happy-app-ota-jacky.oss-cn-hangzhou.aliyuncs.com/meta/android/24/preview/1783710188454.json',
        );
    });

    it('fetches production runtime 25 metadata by default', async () => {
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

        expect(getDefaultOtaRuntimeVersion('production')).toBe('25');
        expect(fetchMock).toHaveBeenCalledWith(
            'https://happy-app-ota-jacky.oss-cn-hangzhou.aliyuncs.com/meta/android/25/production/1783710188454.json',
        );
    });

    it('preserves the existing iOS runtime when selecting OTA metadata', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            json: async () => ({ id: 'ios-update-id', channel: 'production', git: {} }),
        } as Response);

        expect(getDefaultOtaRuntimeVersion('preview', 'ios')).toBe('23');
        expect(getDefaultOtaRuntimeVersion('production', 'ios')).toBe('24');
        await fetchOtaVersion('production', '1783710188454', 'ios');
        expect(fetchMock).toHaveBeenCalledWith(
            'https://happy-app-ota-jacky.oss-cn-hangzhou.aliyuncs.com/meta/ios/24/production/1783710188454.json',
        );
    });
});
