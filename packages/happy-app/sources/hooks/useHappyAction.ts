import * as React from 'react';
import { Modal } from '@/modal';
import { HappyError } from '@/utils/errors';

export function useHappyAction(action: () => Promise<void>) {
    const [loading, setLoading] = React.useState(false);
    const loadingRef = React.useRef(false);
    const doAction = React.useCallback(() => {
        if (loadingRef.current) {
            return;
        }
        loadingRef.current = true;
        setLoading(true);
        (async () => {
            try {
                await action();
            } catch (e) {
                if (e instanceof HappyError) {
                    Modal.alert('Error', e.message, [{ text: 'OK', style: 'cancel' }]);
                } else {
                    Modal.alert('Error', 'Unknown error', [{ text: 'OK', style: 'cancel' }]);
                }
            } finally {
                loadingRef.current = false;
                setLoading(false);
            }
        })();
    }, [action]);
    return [loading, doAction] as const;
}