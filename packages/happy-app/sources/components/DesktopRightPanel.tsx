import * as React from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { PanelTabs, type PanelTab } from './PanelTabs';
import { Typography } from '@/constants/Typography';
import { DesktopPanelResizeHandle } from './DesktopPanelResizeHandle';
import { DesktopShortcutTooltip } from './DesktopShortcutTooltip';
import { useDesktopWorkspaceLayout } from '@/hooks/useDesktopWorkspaceLayout';
import { getDesktopPanelShortcutPresentation } from '@/utils/desktopNavigationLayout';
import { t } from '@/text';

export type DesktopRightPanelTab = PanelTab;

export const DesktopRightPanel = React.memo(function DesktopRightPanel({
    activeTab,
    children,
    collapseAccessibilityLabel,
    collapseLabel,
    onCollapse,
    onTabChange,
    showCollapseButton = true,
    surfaceColor,
    tabs,
}: {
    activeTab: string;
    children: React.ReactNode;
    collapseAccessibilityLabel: string;
    collapseLabel: string;
    onCollapse: () => void;
    onTabChange: (key: string) => void;
    showCollapseButton?: boolean;
    /** The parent owns the photo-skin tint; inner surfaces stay transparent. */
    surfaceColor?: string;
    tabs: readonly DesktopRightPanelTab[];
}) {
    const { theme } = useUnistyles();
    const { enabled: resizable } = useDesktopWorkspaceLayout();
    const [tooltipVisible, setTooltipVisible] = React.useState(false);
    const shortcuts = getDesktopPanelShortcutPresentation();
    const activePanelLabel = tabs.find((tab) => tab.key === activeTab)?.label ?? tabs[0]?.label ?? 'Panel';

    return (
        <View
            style={[styles.container, resizable && styles.containerResizable, surfaceColor && { backgroundColor: surfaceColor }]}
            testID="desktop-right-panel"
        >
            {resizable && (
                <DesktopPanelResizeHandle
                    accessibilityLabel={t('desktopWorkspace.resizePanel', { panel: activePanelLabel })}
                    offset={0}
                    side="right"
                />
            )}
            <View style={[styles.header, surfaceColor && { backgroundColor: 'transparent' }]}>
                <PanelTabs activeTab={activeTab} tabs={tabs} onTabChange={onTabChange} testIDPrefix="desktop-right-panel" />
                {showCollapseButton ? <View style={styles.collapseButtonWrapper}>
                    <Pressable
                        accessibilityHint={`${collapseAccessibilityLabel} (${shortcuts.rightLabel})`}
                        accessibilityLabel={collapseAccessibilityLabel}
                        accessibilityRole="button"
                        {...({
                            'aria-keyshortcuts': shortcuts.rightAria,
                        } as any)}
                        hitSlop={8}
                        onBlur={() => setTooltipVisible(false)}
                        onFocus={() => setTooltipVisible(true)}
                        onHoverIn={() => setTooltipVisible(true)}
                        onHoverOut={() => setTooltipVisible(false)}
                        onPress={onCollapse}
                        style={({ pressed }) => [styles.collapseButton, pressed && styles.pressed]}
                        testID="desktop-right-panel-collapse-button"
                    >
                        <Text style={styles.collapseText}>{collapseLabel}</Text>
                        <Ionicons name="chevron-forward" size={19} color={theme.colors.textSecondary} />
                    </Pressable>
                    <DesktopShortcutTooltip
                        align="right"
                        label={collapseAccessibilityLabel}
                        shortcut={shortcuts.rightLabel}
                        testID="desktop-right-panel-collapse-tooltip"
                        visible={tooltipVisible}
                    />
                </View> : null}
            </View>
            <View style={styles.content}>
                {children}
            </View>
        </View>
    );
});

export const DesktopRightPanelToggleButton = React.memo(function DesktopRightPanelToggleButton({
    expanded,
    label,
    onPress,
}: {
    expanded: boolean;
    label: string;
    onPress: () => void;
}) {
    const { theme } = useUnistyles();
    const [tooltipVisible, setTooltipVisible] = React.useState(false);
    const shortcuts = getDesktopPanelShortcutPresentation();

    return (
        <View style={styles.toggleButtonWrapper}>
            <Pressable
                accessibilityHint={`${label} (${shortcuts.rightLabel})`}
                accessibilityLabel={label}
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                aria-expanded={expanded}
                {...({
                    'aria-keyshortcuts': shortcuts.rightAria,
                } as any)}
                hitSlop={8}
                onBlur={() => setTooltipVisible(false)}
                onFocus={() => setTooltipVisible(true)}
                onHoverIn={() => setTooltipVisible(true)}
                onHoverOut={() => setTooltipVisible(false)}
                onPress={onPress}
                style={({ pressed }) => [
                    styles.toggleButton,
                    expanded && styles.toggleButtonExpanded,
                    pressed && styles.pressed,
                ]}
                testID="desktop-right-panel-toggle-button"
            >
                <Ionicons name="reader-outline" size={19} color={theme.colors.header.tint} />
            </Pressable>
            <DesktopShortcutTooltip
                align="right"
                label={label}
                shortcut={shortcuts.rightLabel}
                testID="desktop-right-panel-toggle-tooltip"
                visible={tooltipVisible}
            />
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        minHeight: 0,
        position: 'relative',
        backgroundColor: theme.colors.groupped.background,
        borderLeftWidth: StyleSheet.hairlineWidth,
        borderLeftColor: theme.colors.divider,
    },
    containerResizable: {
        ...(Platform.OS === 'web' ? { borderRadius: 20, overflow: 'hidden' as const, backgroundColor: theme.colors.surface } : {}),
        borderLeftWidth: 0,
    },
    header: {
        minHeight: 48,
        paddingHorizontal: 8,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    collapseButton: {
        minWidth: 52,
        height: 30,
        paddingLeft: 7,
        paddingRight: 4,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1,
        borderRadius: 8,
    },
    collapseButtonWrapper: {
        position: 'relative',
    },
    collapseText: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    content: {
        flex: 1,
        minHeight: 0,
    },
    toggleButton: {
        width: 40,
        height: 40,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 10,
    },
    toggleButtonExpanded: {
        backgroundColor: theme.colors.surfacePressed,
    },
    toggleButtonWrapper: {
        position: 'relative',
        width: 40,
        height: 40,
    },
    pressed: {
        opacity: 0.7,
    },
}));
