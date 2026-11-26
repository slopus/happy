import * as React from 'react';
import { useIsFocused, useNavigation } from '@react-navigation/native';
import { Modal } from '@/modal';
import { t } from '@/text';

/** Flush/confirm the native editor before a route can remove its iframe. */
export function MotionNavigationGuard({ enabled, prepareLeave }: { enabled: boolean; prepareLeave(): Promise<boolean> }) {
    const navigation = useNavigation();
    const focused = useIsFocused();
    const guard = React.useRef(prepareLeave); guard.current = prepareLeave;
    React.useEffect(() => {
        if (!enabled || !focused) return;
        let live = true, pending = false, allowed = false;
        const remove = navigation.addListener('beforeRemove', event => {
            if (allowed) return;
            event.preventDefault();
            if (pending) return;
            pending = true;
            void guard.current().then(ready => {
                if (!live) return;
                if (!ready) { Modal.alert(t('motionWorkbench.title'), t('motionWorkbench.closeBlocked')); return; }
                allowed = true;
                try { navigation.dispatch(event.data.action); } finally { allowed = false; }
            }).catch(error => { if (live) Modal.alert(t('common.error'), error instanceof Error ? error.message : String(error)); })
                .finally(() => { pending = false; });
        });
        return () => { live = false; remove(); };
    }, [enabled, focused, navigation]);
    return null;
}
