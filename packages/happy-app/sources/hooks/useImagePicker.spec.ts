import { describe, it, expect, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-image-picker', () => ({}));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/utils/thumbhash', () => ({ generateThumbhash: vi.fn() }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/sync/attachmentTypes', () => ({}));

import { isPermissionAccepted } from './useImagePicker';

describe('isPermissionAccepted', () => {
    it('accepts granted', () => {
        expect(isPermissionAccepted('granted')).toBe(true);
    });

    it('accepts limited -- iOS 14+ PHPickerViewController still works', () => {
        expect(isPermissionAccepted('limited')).toBe(true);
    });

    it('rejects denied', () => {
        expect(isPermissionAccepted('denied')).toBe(false);
    });

    it('rejects undetermined', () => {
        expect(isPermissionAccepted('undetermined')).toBe(false);
    });
});
