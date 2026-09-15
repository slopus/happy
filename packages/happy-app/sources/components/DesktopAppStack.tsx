import * as React from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { useNavigationBuilder, createNavigatorFactory, type ParamListBase, type StackActionHelpers, type StackNavigationState, type StackRouterOptions } from '@react-navigation/native';
import { NativeStackView, type NativeStackNavigationOptions, type NativeStackNavigationEventMap, type NativeStackNavigatorProps } from '@react-navigation/native-stack';
import { withLayoutContext } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { registerDesktopModalNavigation } from '@/navigation/desktopModalNavigation';
import { createDesktopModalRouter, getDesktopModalStart } from '@/navigation/desktopModalRouter';
import { DesktopModalSceneContext } from './DesktopModalScene';
import { DesktopWorkspaceLayoutIsolation } from '@/hooks/useDesktopWorkspaceLayout';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

export function focusDesktopModalInitialTarget(
    panel: HTMLElement | null,
    activeElement: Element | null = typeof document === 'undefined' ? null : document.activeElement,
) {
    if (!panel || (activeElement && panel.contains(activeElement))) return;
    panel.querySelector<HTMLElement>('[data-testid="desktop-modal-close"]')?.focus();
}

/** A real Expo-compatible stack, rendered in one desktop dialog after a modal entry. */
export function DesktopStackNavigator({ children, initialRouteName, screenOptions, screenListeners, ...rest }: NativeStackNavigatorProps) {
    const { state, descriptors, navigation, describe, NavigationContent } = useNavigationBuilder<
        StackNavigationState<ParamListBase>, StackRouterOptions, StackActionHelpers<ParamListBase>, NativeStackNavigationOptions, NativeStackNavigationEventMap
    >(createDesktopModalRouter, { children, initialRouteName, screenOptions, screenListeners, id: rest.id });
    const { theme } = useUnistyles();
    const start = getDesktopModalStart(state);
    const visible = start >= 0;
    const current = descriptors[state.routes[state.index].key];
    const panelRef = React.useRef<any>(null);
    const close = React.useCallback(() => navigation.dispatch({ type: 'CLOSE_DESKTOP_MODAL', target: state.key }), [navigation, state.key]);
    React.useEffect(() => {
        if (visible) return registerDesktopModalNavigation({ back: () => navigation.goBack(), close });
    }, [visible, navigation, close]);
    const backgroundState = visible ? { ...state, preloadedRoutes: [], routes: state.routes.slice(0, start), index: start - 1 } : state;
    const modalState = visible ? { ...state, preloadedRoutes: [], routes: state.routes.slice(start), index: state.index - start } : state;
    const modalDescriptors = React.useMemo(() => Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, {
        ...descriptor, options: { ...descriptor.options, headerShown: false },
    }])), [descriptors]);
    const rootName = visible ? state.routes[start].name : '';
    const fallbackTitle = rootName === 'inbox/index' ? t('tabs.inbox') : t('settings.title');
    const title = current.options.headerTitle || current.options.title || fallbackTitle;

    React.useEffect(() => {
        if (!visible || typeof document === 'undefined') return;
        const previous = document.activeElement as HTMLElement | null;
        const frame = requestAnimationFrame(() => focusDesktopModalInitialTarget(panelRef.current));
        return () => { cancelAnimationFrame(frame); if (previous?.isConnected) previous.focus(); };
    }, [visible]);

    return <NavigationContent>
        <NativeStackView {...rest} state={backgroundState} descriptors={descriptors} navigation={navigation} describe={describe} />
        <Modal transparent visible={visible} animationType="fade" onRequestClose={close}>
            <View style={styles.overlay} testID="desktop-modal-root" {...({ onKeyDown: (event: any) => {
                if (event.nativeEvent.key === 'Escape') {
                    event.preventDefault(); event.stopPropagation(); close();
                }
            } } as any)}>
                <Pressable accessible={false} style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.shadow.color, opacity: 0.42 }]} onPress={close} testID="desktop-modal-backdrop" />
                <View ref={panelRef} style={styles.panel} accessibilityViewIsModal accessibilityLabel={typeof title === 'string' ? title : fallbackTitle} {...({ role: 'dialog', 'aria-modal': true } as any)} testID="desktop-modal-panel">
                    <View style={styles.header}>
                        {state.index > start ? <Pressable accessibilityRole="button" accessibilityLabel={t('common.back')} onPress={() => navigation.goBack()} style={({ pressed }) => [styles.button, pressed && styles.pressed]} testID="desktop-modal-back"><Ionicons name="chevron-back" size={22} color={theme.colors.header.tint} /></Pressable> : <View style={styles.spacer} />}
                        <View style={styles.title}>{typeof title === 'function' ? title({ children: fallbackTitle, tintColor: theme.colors.header.tint }) : <Text style={styles.titleText} numberOfLines={1}>{title}</Text>}</View>
                        {current.options.headerRight?.({ canGoBack: state.index > start, tintColor: theme.colors.header.tint })}
                        <Pressable accessibilityRole="button" accessibilityLabel={t('sidebarLists.close')} onPress={close} style={({ pressed }) => [styles.button, pressed && styles.pressed]} testID="desktop-modal-close"><Ionicons name="close" size={22} color={theme.colors.header.tint} /></Pressable>
                    </View>
                    {visible && <DesktopModalSceneContext.Provider value={true}><DesktopWorkspaceLayoutIsolation>
                        <NativeStackView {...rest} state={modalState} descriptors={modalDescriptors} navigation={navigation} describe={describe} />
                    </DesktopWorkspaceLayoutIsolation></DesktopModalSceneContext.Provider>}
                </View>
            </View>
        </Modal>
    </NavigationContent>;
}

const Navigator = createNavigatorFactory(DesktopStackNavigator)().Navigator;
export const DesktopAppStack = withLayoutContext<NativeStackNavigationOptions, typeof Navigator, StackNavigationState<ParamListBase>, NativeStackNavigationEventMap>(Navigator);

const styles = StyleSheet.create(theme => ({
    overlay: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
    panel: { flex: 1, width: '100%', maxWidth: 1040, maxHeight: 900, borderRadius: 12, overflow: 'hidden', backgroundColor: theme.colors.surface, borderColor: theme.colors.divider, borderWidth: StyleSheet.hairlineWidth, boxShadow: `0 16px 44px ${theme.colors.shadow.color}` },
    header: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider, backgroundColor: theme.colors.header.background },
    button: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 6, backgroundColor: theme.colors.surface },
    pressed: { backgroundColor: theme.colors.surfacePressed },
    spacer: { width: 36 },
    title: { flex: 1, minWidth: 0 },
    titleText: { color: theme.colors.header.tint, fontSize: 17, ...Typography.default('semiBold') },
}));
