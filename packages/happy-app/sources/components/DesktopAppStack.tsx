import * as React from 'react';
import { Modal, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { useNavigationBuilder, createNavigatorFactory, type ParamListBase, type StackActionHelpers, type StackNavigationState, type StackRouterOptions } from '@react-navigation/native';
import { NativeStackView, type NativeStackNavigationOptions, type NativeStackNavigationEventMap, type NativeStackNavigatorProps } from '@react-navigation/native-stack';
import { withLayoutContext } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { runRoleFlowNavigationBack, runRoleFlowNavigationClose } from '@/navigation/roleFlowNavigation';
import { registerDesktopModalNavigation } from '@/navigation/desktopModalNavigation';
import { createDesktopModalRouter, getDesktopModalStart } from '@/navigation/desktopModalRouter';
import { DesktopModalSceneContext } from './DesktopModalScene';
import { DesktopWorkspaceLayoutIsolation } from '@/hooks/useDesktopWorkspaceLayout';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { BotsActivity } from './bots/BotsActivity';
import { WEB_TABLET_MIN_WIDTH } from '@/utils/desktopNavigationLayout';
import { ToolDetailContentSizeContext } from './tools/ToolDetailLayout';

export function focusDesktopModalInitialTarget(
    panel: HTMLElement | null,
    activeElement: Element | null = typeof document === 'undefined' ? null : document.activeElement,
) {
    if (!panel || (activeElement && panel.contains(activeElement))) return;
    panel.querySelector<HTMLElement>('[data-testid="desktop-modal-close"]')?.focus();
}

/** A real Expo-compatible stack, rendered in one desktop dialog after a modal entry. */
export function DesktopStackNavigator({ children, initialRouteName, screenOptions, screenListeners, ...rest }: NativeStackNavigatorProps) {
    const { width } = useWindowDimensions();
    const desktopToolDetails = React.useRef(width >= WEB_TABLET_MIN_WIDTH);
    desktopToolDetails.current = width >= WEB_TABLET_MIN_WIDTH;
    const router = React.useCallback((options: StackRouterOptions) => createDesktopModalRouter(options, () => desktopToolDetails.current), []);
    const { state, descriptors, navigation, describe, NavigationContent } = useNavigationBuilder<
        StackNavigationState<ParamListBase>, StackRouterOptions, StackActionHelpers<ParamListBase>, NativeStackNavigationOptions, NativeStackNavigationEventMap
    >(router, { children, initialRouteName, screenOptions, screenListeners, id: rest.id });
    const { theme } = useUnistyles();
    const start = getDesktopModalStart(state);
    const visible = start >= 0;
    const current = descriptors[state.routes[state.index].key];
    const toolDetails = current.route.name === 'session/[id]/message/[messageId]';
    const roleSettings = current.route.name === 'settings/delegation-roles';
    const [toolSize, setToolSize] = React.useState({ key: '', height: 0 });
    const currentKey = React.useRef(current.route.key);
    currentKey.current = current.route.key;
    const recordToolSize = React.useCallback((key: string, height: number) => {
        if (key !== currentKey.current || !Number.isFinite(height) || height <= 0) return;
        const rounded = Math.ceil(height);
        setToolSize(previous => previous.key === key && previous.height === rounded ? previous : { key, height: rounded });
    }, []);
    const toolPanelHeight = toolSize.key === current.route.key ? Math.max(240, Math.min(640, toolSize.height + 58)) : 640;
    const panelRef = React.useRef<any>(null);
    const close = React.useCallback(() => { if (!runRoleFlowNavigationClose()) navigation.dispatch({ type: 'CLOSE_DESKTOP_MODAL', target: state.key }); }, [navigation, state.key]);
    React.useEffect(() => {
        if (visible) return registerDesktopModalNavigation({ back: () => { if (!runRoleFlowNavigationBack()) navigation.goBack(); }, close });
    }, [visible, navigation, close]);
    const backgroundState = visible ? { ...state, preloadedRoutes: [], routes: state.routes.slice(0, start), index: start - 1 } : state;
    const modalState = visible ? { ...state, preloadedRoutes: [], routes: state.routes.slice(start), index: state.index - start } : state;
    const modalDescriptors = React.useMemo(() => Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, {
        ...descriptor, options: { ...descriptor.options, headerShown: false },
        render: descriptor.route.name === 'session/[id]/message/[messageId]' ? () => (
            <ToolDetailContentSizeContext.Provider value={key === current.route.key ? height => recordToolSize(key, height) : null}>
                {descriptor.render()}
            </ToolDetailContentSizeContext.Provider>
        ) : descriptor.render,
    }])), [descriptors, current.route.key, recordToolSize]);
    // Keep one renderer outside the route stack. Navigating home or to a session can
    // remove a Bots route; that must not tear down its authenticated React runtime.
    const botsRenderer = React.useRef<(() => React.ReactNode) | null>(null);
    const botsRoute = state.routes.find(route => route.name === 'bots');
    if (!botsRenderer.current && botsRoute) botsRenderer.current = descriptors[botsRoute.key].render;
    const botsActive = state.routes[backgroundState.index]?.name === 'bots';
    const backgroundDescriptors = React.useMemo(() => Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key,
        descriptor.route.name === 'bots' ? { ...descriptor, render: () => <React.Fragment /> } : descriptor,
    ])), [descriptors]);
    const fallbackTitle = t(toolDetails ? 'common.message' : 'settings.title');
    const title = current.options.headerTitle || current.options.title || fallbackTitle;

    React.useEffect(() => {
        if (!visible || typeof document === 'undefined') return;
        const previous = document.activeElement as HTMLElement | null;
        const frame = requestAnimationFrame(() => focusDesktopModalInitialTarget(panelRef.current));
        return () => { cancelAnimationFrame(frame); if (previous?.isConnected) previous.focus(); };
    }, [visible]);

    return <NavigationContent>
        <NativeStackView {...rest} state={backgroundState} descriptors={backgroundDescriptors} navigation={navigation} describe={describe} />
        {botsRenderer.current && <View testID="persistent-bots-workspace" style={[StyleSheet.absoluteFill, { display: botsActive ? 'flex' : 'none' }]}>
            <BotsActivity.Provider value={botsActive}>{botsRenderer.current()}</BotsActivity.Provider>
        </View>}
        <Modal transparent visible={visible} animationType="fade" onRequestClose={close} accessibilityLabel={typeof title === 'string' ? title : fallbackTitle}>
            <View style={styles.overlay} testID="desktop-modal-root" {...({ onKeyDown: (event: any) => {
                if (event.nativeEvent.key === 'Escape') {
                    event.preventDefault(); event.stopPropagation(); close();
                }
            } } as any)}>
                <View accessible={false} style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.modal.backdrop }]} onStartShouldSetResponder={() => true} onResponderRelease={close} testID="desktop-modal-backdrop" />
                <View ref={panelRef} style={[styles.panel, toolDetails && styles.toolPanel, toolDetails && { maxHeight: toolPanelHeight }]} testID="desktop-modal-panel">
                    {!roleSettings && <View style={styles.header}>
                        {state.index > start ? <Pressable accessibilityRole="button" accessibilityLabel={t('common.back')} onPress={() => navigation.goBack()} style={({ pressed }) => [styles.button, pressed && styles.pressed]} testID="desktop-modal-back"><Ionicons name="chevron-back" size={22} color={theme.colors.header.tint} /></Pressable> : <View style={styles.spacer} />}
                        <View style={styles.title}>{typeof title === 'function' ? title({ children: fallbackTitle, tintColor: theme.colors.header.tint }) : <Text style={styles.titleText} numberOfLines={1}>{title}</Text>}</View>
                        {!toolDetails && current.options.headerRight?.({ canGoBack: state.index > start, tintColor: theme.colors.header.tint })}
                        <Pressable accessibilityRole="button" accessibilityLabel={t('sidebarLists.close')} onPress={close} style={({ pressed }) => [styles.button, pressed && styles.pressed]} testID="desktop-modal-close"><Ionicons name="close" size={22} color={theme.colors.header.tint} /></Pressable>
                    </View>}
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
    toolPanel: { maxWidth: 800, maxHeight: 640 },
    header: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider, backgroundColor: theme.colors.header.background },
    button: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 6, backgroundColor: theme.colors.surface },
    pressed: { backgroundColor: theme.colors.surfacePressed },
    spacer: { width: 36 },
    title: { flex: 1, minWidth: 0 },
    titleText: { color: theme.colors.header.tint, fontSize: 17, ...Typography.default('semiBold') },
}));
