import { describe, expect, it, vi } from 'vitest';

vi.mock('@/sync/persistence', () => {
    throw new Error('public share graph must not evaluate private persistence');
});
vi.mock('react-native-mmkv', () => {
    throw new Error('public share graph must not construct MMKV storage');
});
vi.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }));

import { getPublicSessionAttachmentUrl } from './publicSessionShareViewer';
import { publicSessionShareText } from '@/text/publicSessionShareText';

describe('public session share module isolation', () => {
    it('loads viewer API and localized copy without private app persistence', () => {
        vi.stubGlobal('location', { origin: 'https://paws.test' });
        expect(getPublicSessionAttachmentUrl('share', 'asset')).toBe(
            'https://paws.test/v1/public/session-shares/share/attachments/asset',
        );
        expect(publicSessionShareText('sessionShare.sharedViaPaws')).toBeTruthy();
        vi.unstubAllGlobals();
    });
});
