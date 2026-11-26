import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';
import { t } from '@/text';

export type RoleFlowAction = {
    label: string;
    onPress: () => void;
    disabled?: boolean;
    loading?: boolean;
    testID?: string;
    icon?: React.ReactNode;
};

type Props = React.PropsWithChildren<{
    title: string;
    subtitle?: string;
    back?: RoleFlowAction;
    close?: RoleFlowAction;
    action?: RoleFlowAction;
    step?: 1 | 2;
    footer?: { hint: string; primary: RoleFlowAction; secondary: RoleFlowAction };
    scrollKey: string;
    scrollPositions?: Map<string, number>;
}>;

/** The accepted role flow owns three separate regions: navigation, scrolling
 * content and persistent actions. Forms never turn their actions into rows. */
export function RoleFlowScaffold({ title, subtitle, back, close, action, step, footer, scrollKey, scrollPositions, children }: Props) {
    const { theme } = useUnistyles();
    const { width } = useWindowDimensions();
    const insets = useSafeAreaInsets();
    const compact = width < 600;
    const scroll = React.useRef<ScrollView>(null);
    React.useLayoutEffect(() => { scroll.current?.scrollTo({ y: scrollPositions?.get(scrollKey) ?? 0, animated: false }); }, [scrollKey, scrollPositions]);
    return <View style={styles.root} testID="delegation-role-settings">
        <View style={styles.frame}>
            <View style={[styles.header, compact && styles.compactHorizontal, { paddingTop: 18 + insets.top }]} testID="delegation-flow-header">
                <View style={styles.headerLeading}>
                    {back ? <RoleFlowButton {...back} variant="text" /> : null}
                    <View style={styles.titleCopy}>
                        <Text accessibilityRole="header" style={[styles.title, back && styles.subTitle]} testID="delegation-flow-title">{title}</Text>
                        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
                    </View>
                </View>
                <View style={styles.headerActions}>{action ? <RoleFlowButton {...action} variant="primary" /> : null}{close ? <RoleFlowButton {...close}
                    icon={<Ionicons name="close-outline" size={22} color={theme.colors.textSecondary} />} variant="icon" /> : null}</View>
            </View>
            {step ? <View style={[styles.steps, compact && styles.compactHorizontal]} accessibilityLabel={t('delegation.stepHint', { step, total: 2 })}
                testID="delegation-settings-steps">
                <Step number={1} label={t('delegation.responsibilityStep')} current={step === 1} complete={step === 2} />
                <View style={styles.stepConnector} />
                <Step number={2} label={t('delegation.executionStep')} current={step === 2} />
            </View> : null}
            <ScrollView ref={scroll} style={styles.scroll} contentContainerStyle={[styles.body, compact && styles.compactHorizontal]}
                keyboardShouldPersistTaps="handled" onScroll={event => scrollPositions?.set(scrollKey, event.nativeEvent.contentOffset.y)} scrollEventThrottle={16} testID="delegation-flow-body">
                {children}
            </ScrollView>
            {footer ? <View style={[styles.footer, compact && styles.compactFooter, { paddingBottom: Math.max(14, insets.bottom) }]}
                testID="delegation-flow-footer">
                <Text style={styles.footerHint} numberOfLines={compact ? 2 : undefined} accessibilityLabel={footer.hint}>{footer.hint}</Text>
                <View style={styles.footerActions}>
                    <RoleFlowButton {...footer.secondary} variant="secondary" />
                    <RoleFlowButton {...footer.primary} variant="primary" />
                </View>
            </View> : null}
        </View>
    </View>;
}

function Step({ number, label, current, complete }: { number: number; label: string; current: boolean; complete?: boolean }) {
    const { theme } = useUnistyles();
    return <View style={styles.step}>
        <View style={[styles.stepBadge, current && styles.currentBadge, complete && styles.completedBadge]}>
            {complete ? <Ionicons name="checkmark-outline" size={15} color={theme.colors.textLink} />
                : <Text style={[styles.stepNumber, current && styles.currentNumber]}>{number}</Text>}
        </View>
        <Text style={[styles.stepLabel, current && styles.currentLabel]}>{label}</Text>
    </View>;
}

/** A compact role-flow action using the same theme pairing as RoundButton. */
export function RoleFlowButton({ label, onPress, disabled, loading, testID, icon, variant = 'secondary' }: RoleFlowAction & { variant?: 'primary' | 'secondary' | 'text' | 'danger' | 'icon' }) {
    const { theme } = useUnistyles();
    const [focused, setFocused] = React.useState(false);
    const unavailable = !!disabled || !!loading;
    const textColor = variant === 'primary' ? theme.colors.button.primary.tint : variant === 'danger' ? theme.colors.textDestructive : theme.colors.text;
    return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: unavailable, busy: !!loading }}
        disabled={unavailable} testID={testID} onPress={onPress} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        style={(state: { pressed: boolean; hovered?: boolean }) => [styles.button,
            variant === 'primary' ? styles.primary : variant === 'text' || variant === 'danger' || variant === 'icon' ? styles.textButton : styles.secondary,
            variant === 'icon' && styles.iconButton,
            !unavailable && (state.pressed || state.hovered) && (variant === 'primary' ? styles.primaryPressed : styles.pressed),
            focused && styles.focused, unavailable && styles.disabled]}>
        {loading ? <ActivityIndicator size="small" color={textColor} /> : icon}
        {variant !== 'icon' ? <Text style={[styles.buttonLabel, { color: textColor }, variant === 'text' && styles.backLabel]}>{label}</Text> : null}
    </Pressable>;
}

const styles = StyleSheet.create(theme => ({
    root: { flex: 1, minHeight: 0, backgroundColor: theme.colors.groupped.background },
    frame: { flex: 1, minHeight: 0, width: '100%', maxWidth: layout.maxWidth, alignSelf: 'center' },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 28, paddingVertical: 18, borderBottomWidth: 1, borderBottomColor: theme.colors.divider, flexShrink: 0 },
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 },
    headerLeading: { flexDirection: 'row', gap: 10, alignItems: 'center', flex: 1, minWidth: 0 },
    titleCopy: { flex: 1, minWidth: 0, gap: 5 },
    title: { ...Typography.default('semiBold'), fontSize: 22, lineHeight: 29, color: theme.colors.text },
    subTitle: { fontSize: 19, lineHeight: 26 },
    subtitle: { ...Typography.default(), color: theme.colors.textSecondary, fontSize: 13, lineHeight: 20 },
    scroll: { flex: 1, minHeight: 0 },
    body: { paddingHorizontal: 28, paddingTop: 20, paddingBottom: 28 },
    compactHorizontal: { paddingHorizontal: 18 },
    steps: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 14, paddingHorizontal: 28, paddingVertical: 18, borderBottomWidth: 1, borderBottomColor: theme.colors.divider, flexShrink: 0 },
    step: { flexDirection: 'row', gap: 8, alignItems: 'center', minWidth: 0, flexShrink: 1 },
    stepBadge: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surfacePressed },
    currentBadge: { backgroundColor: theme.colors.button.primary.background },
    completedBadge: { backgroundColor: theme.colors.surfaceSelected },
    stepNumber: { ...Typography.default('semiBold'), fontSize: 12, lineHeight: 17, color: theme.colors.textSecondary },
    currentNumber: { color: theme.colors.button.primary.tint },
    stepLabel: { ...Typography.default(), color: theme.colors.textSecondary, fontSize: 13, lineHeight: 20, flexShrink: 1 },
    currentLabel: { ...Typography.default('semiBold'), color: theme.colors.text },
    stepConnector: { width: 32, height: 1, backgroundColor: theme.colors.divider, flexShrink: 1 },
    footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 28, paddingTop: 14, borderTopWidth: 1, borderTopColor: theme.colors.divider, backgroundColor: theme.colors.groupped.background, flexShrink: 0 },
    compactFooter: { paddingHorizontal: 18, gap: 8 },
    footerHint: { ...Typography.default(), color: theme.colors.textSecondary, fontSize: 12, lineHeight: 18, flex: 1, minWidth: 0, flexShrink: 1 },
    footerActions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 8, flexShrink: 0 },
    button: { minHeight: 42, borderRadius: 8, borderWidth: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingHorizontal: 14, paddingVertical: 9 },
    buttonLabel: { ...Typography.default('semiBold'), fontSize: 13, lineHeight: 19 },
    primary: { backgroundColor: theme.colors.button.primary.background, borderColor: 'transparent' },
    secondary: { backgroundColor: theme.colors.surface, borderColor: theme.colors.divider },
    textButton: { backgroundColor: 'transparent', borderColor: 'transparent', paddingHorizontal: 0 },
    iconButton: { width: 40, minWidth: 40, height: 40, padding: 8, flexShrink: 0 },
    backLabel: { ...Typography.default(), color: theme.colors.textSecondary, fontSize: 12 },
    primaryPressed: { opacity: 0.9 },
    pressed: { backgroundColor: theme.colors.surfacePressed },
    focused: { borderColor: theme.colors.textLink },
    disabled: { opacity: 0.45 },
}));
