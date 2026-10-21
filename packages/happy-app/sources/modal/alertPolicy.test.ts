import { beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ OS: 'android' as string }));
const nativeAlert = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
    Platform: platform,
    Alert: { alert: nativeAlert },
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));

import { getAlertDismissal } from './alertPolicy';
import { Modal } from './ModalManager';

describe('getAlertDismissal', () => {
    it('dismisses an informational alert with no buttons or only a plain OK', () => {
        expect(getAlertDismissal(undefined).dismissible).toBe(true);
        expect(getAlertDismissal([{ text: 'OK' }]).dismissible).toBe(true);
    });

    it('treats dismissing as pressing Cancel', () => {
        const onCancel = vi.fn();
        const dismissal = getAlertDismissal([{ text: 'Go', onPress: () => {} }, { text: 'Cancel', style: 'cancel', onPress: onCancel }]);
        expect(dismissal.dismissible).toBe(true);
        dismissal.onDismiss?.();
        expect(onCancel).toHaveBeenCalledOnce();
    });

    it('keeps an alert open when its only way out is an action', () => {
        expect(getAlertDismissal([{ text: 'Delete', style: 'destructive', onPress: () => {} }]).dismissible).toBe(false);
    });
});

describe('Modal on Android', () => {
    beforeEach(() => {
        platform.OS = 'android';
        nativeAlert.mockReset();
    });

    it('lets Back and outside taps close a native alert that has a Cancel', () => {
        const onCancel = vi.fn();
        const buttons = [
            { text: 'Browse known issues', onPress: () => {} },
            { text: 'Ask on Discord', onPress: () => {} },
            { text: 'Cancel', style: 'cancel' as const, onPress: onCancel },
        ];
        Modal.alert('Get help', 'Stuck? Come ask us.', buttons);
        const [, , passed, options] = nativeAlert.mock.calls[0];
        expect(passed).toBe(buttons);
        expect(options.cancelable).toBe(true);
        options.onDismiss();
        expect(onCancel).toHaveBeenCalledOnce();
    });

    it('keeps an alert whose only button acts closed to Back and outside taps', () => {
        Modal.alert('Restart required', undefined, [{ text: 'Restart', onPress: () => {} }]);
        expect(nativeAlert.mock.calls[0][3].cancelable).toBe(false);
    });

    it('keeps confirm dialogs closed to outside taps', () => {
        void Modal.confirm('Delete?', undefined, { destructive: true });
        expect(nativeAlert.mock.calls[0][3]).toEqual({ cancelable: false });
    });
});
