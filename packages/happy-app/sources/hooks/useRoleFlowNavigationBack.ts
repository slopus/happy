import * as React from 'react';
import { BackHandler, Platform } from 'react-native';
import { useIsFocused, useNavigation, usePreventRemove } from '@react-navigation/native';
import { registerRoleFlowNavigation } from '@/navigation/roleFlowNavigation';
import { Modal } from '@/modal';
import { t } from '@/text';

type Options = { enabled: boolean; interceptClose?: boolean; onBack: () => void | Promise<void>; onClose?: () => void | Promise<void> };
/** Keep the app's original back arrow, hardware back and local header on the
 * same role step. Forward navigation (including AI handoff) is never trapped. */
export function useRoleFlowNavigationBack({ enabled, interceptClose = true, onBack, onClose }: Options) {
    const focused = useIsFocused();
    const navigation = useNavigation();
    const handlers = React.useRef({ onBack, onClose });
    handlers.current = { onBack, onClose };
    const invokeRef = React.useRef<(close: boolean) => void>(() => {});
    usePreventRemove(enabled && focused && Platform.OS !== 'web', ({ data }) => {
        if (data.action.type === 'CLOSE_DESKTOP_MODAL' && !interceptClose) {
            navigation.dispatch(data.action);
        } else if (['GO_BACK', 'POP', 'POP_TO_TOP', 'CLOSE_DESKTOP_MODAL'].includes(data.action.type)) {
            invokeRef.current(data.action.type === 'CLOSE_DESKTOP_MODAL');
        } else {
            // React Navigation marks this action as already visited, so a
            // forward handoff/replacement continues without another prompt.
            navigation.dispatch(data.action);
        }
    });
    React.useEffect(() => {
        if (!enabled || !focused) return;
        const owner = {};
        let pending = false;
        let live = true;
        const invoke = (close: boolean) => {
            if (!live || pending) return;
            pending = true;
            void Promise.resolve().then(() => live ? (close ? handlers.current.onClose ?? handlers.current.onBack : handlers.current.onBack)() : undefined)
                .catch(error => { if (live) Modal.alert(t('common.error'), error instanceof Error ? error.message : t('common.retry')); })
                .finally(() => { pending = false; });
        };
        invokeRef.current = invoke;
        if (Platform.OS !== 'web') navigation.setOptions({ headerBackButtonMenuEnabled: false });
        const unregister = registerRoleFlowNavigation({ owner, back: () => invoke(false), close: interceptClose ? () => invoke(true) : undefined });
        const hardware = Platform.OS === 'android' ? BackHandler.addEventListener('hardwareBackPress', () => { invoke(false); return true; }) : null;
        const remove = Platform.OS === 'web' ? navigation.addListener('beforeRemove', event => {
            const action = event.data.action.type;
            if (action === 'CLOSE_DESKTOP_MODAL' && !interceptClose) return;
            if (!['GO_BACK', 'POP', 'POP_TO_TOP', 'CLOSE_DESKTOP_MODAL'].includes(action)) return;
            event.preventDefault(); invoke(action === 'CLOSE_DESKTOP_MODAL');
        }) : null;
        return () => { live = false; invokeRef.current = () => {}; unregister(); hardware?.remove(); remove?.(); };
    }, [enabled, focused, navigation, interceptClose]);
}
