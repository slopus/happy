import React from 'react';
import { View, Text, Pressable, TextInput, Platform, ScrollView, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { AIBackendProfile, SavedSecret } from '@/sync/settings';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useMachineEnvPresence } from '@/hooks/useMachineEnvPresence';
import { SecretsList } from '@/components/secrets/SecretsList';
import { ItemListStatic } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { useMachine } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';

const secretRequirementSelectionMemory = new Map<string, 'machine' | 'saved' | 'once'>();

export type SecretRequirementModalResult =
    | { action: 'cancel' }
    | { action: 'useMachine'; envVarName: string }
    | { action: 'selectSaved'; envVarName: string; secretId: string; setDefault: boolean }
    | { action: 'enterOnce'; envVarName: string; value: string };

export type SecretRequirementModalVariant = 'requirement' | 'defaultForProfile';

export interface SecretRequirementModalProps {
    profile: AIBackendProfile;
    /**
     * The specific secret environment variable name this modal is resolving (e.g. OPENAI_API_KEY).
     * This must correspond to a `profile.envVarRequirements[]` entry with `kind='secret'`.
     */
    secretEnvVarName: string;
    /**
     * Optional: allow resolving multiple secret env vars within the same modal.
     * When provided (and when `variant="requirement"`), the user can switch which secret
     * they're resolving via a dropdown.
     */
    secretEnvVarNames?: ReadonlyArray<string>;
    machineId: string | null;
    secrets: SavedSecret[];
    defaultSecretId: string | null;
    selectedSavedSecretId?: string | null;
    /**
     * Optional per-env state (used to preselect and persist across reopens).
     * These are keyed by env var name (UPPERCASE).
     */
    selectedSecretIdByEnvVarName?: Readonly<Record<string, string | null | undefined>> | null;
    sessionOnlySecretValueByEnvVarName?: Readonly<Record<string, string | null | undefined>> | null;
    defaultSecretIdByEnvVarName?: Readonly<Record<string, string | null | undefined>> | null;
    /**
     * When provided, toggling "default" updates the default without selecting a key for the current flow.
     * (Lets the user keep the modal open and still pick a different key for just this session.)
     */
    onSetDefaultSecretId?: (id: string | null) => void;
    /**
     * Controls presentation. `defaultForProfile` is a simplified view that only lets the user choose
     * a saved key as the profile default.
     */
    variant?: SecretRequirementModalVariant;
    titleOverride?: string;
    onChangeSecrets?: (next: SavedSecret[]) => void;
    onResolve: (result: SecretRequirementModalResult) => void;
    onClose: () => void;
    /**
     * Optional hook invoked when the modal is dismissed (e.g. backdrop tap).
     * Used by the modal host to route dismiss -> cancel.
     */
    onRequestClose?: () => void;
    allowSessionOnly?: boolean;
    /**
     * Layout variant:
     * - `modal` (default): centered, content-sized card (web + legacy overlays)
     * - `screen`: full-width/full-height screen content (native route screens)
     */
    layoutVariant?: 'modal' | 'screen';
}

export function SecretRequirementModal(props: SecretRequirementModalProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const insets = useSafeAreaInsets();
    const { height: windowHeight } = useWindowDimensions();

    const layoutVariant: 'modal' | 'screen' = props.layoutVariant ?? 'modal';

    // Dynamic sizing: content-sized until we hit a max height, then scroll internally.
    const maxHeight = React.useMemo(() => {
        if (layoutVariant === 'screen') {
            return Math.max(260, windowHeight);
        }
        // Keep some breathing room from the screen edges.
        const margin = 24;
        // NOTE: `useWindowDimensions().height` is already affected by navigation presentation on iOS.
        // Subtracting safe-area again can over-shrink and cause awkward cropping.
        return Math.max(260, windowHeight - margin * 2);
    }, [layoutVariant, windowHeight]);

    const [headerHeight, setHeaderHeight] = React.useState(0);
    const scrollMaxHeight = Math.max(0, maxHeight - headerHeight);
    const popoverBoundaryRef = React.useRef<View>(null);
    // IMPORTANT:
    // The secret requirement modal can be intentionally small (content-sized). If we use the modal's
    // internal scroll container as the Popover boundary, dropdown menus get their maxHeight clipped
    // to the modal instead of the screen. Use a "null boundary" ref so Popover falls back to the
    // full window bounds while still anchoring to the trigger.
    const screenPopoverBoundaryRef = React.useMemo(() => ({ current: null } as React.RefObject<any>), []);

    const fades = useScrollEdgeFades({
        enabledEdges: { top: true, bottom: true },
        overflowThreshold: 1,
        edgeThreshold: 1,
    });

    const normalizedSecretEnvVarName = React.useMemo(() => props.secretEnvVarName.trim().toUpperCase(), [props.secretEnvVarName]);
    const secretEnvVarNames = React.useMemo(() => {
        const raw = props.secretEnvVarNames && props.secretEnvVarNames.length > 0
            ? props.secretEnvVarNames
            : [normalizedSecretEnvVarName];
        const uniq: string[] = [];
        for (const n of raw) {
            const v = String(n ?? '').trim().toUpperCase();
            if (!v) continue;
            if (!uniq.includes(v)) uniq.push(v);
        }
        return uniq;
    }, [normalizedSecretEnvVarName, props.secretEnvVarNames]);

    const [activeEnvVarName, setActiveEnvVarName] = React.useState(() => normalizedSecretEnvVarName);
    const envPresence = useMachineEnvPresence(
        props.machineId,
        secretEnvVarNames,
        { ttlMs: 2 * 60_000 },
    );
    const machine = useMachine(props.machineId ?? '');

    const variant: SecretRequirementModalVariant = props.variant ?? 'requirement';

    const [sessionOnlyValue, setSessionOnlyValue] = React.useState(() => {
        const initial = props.sessionOnlySecretValueByEnvVarName?.[activeEnvVarName];
        return typeof initial === 'string' ? initial : '';
    });
    const sessionOnlyInputRef = React.useRef<TextInput>(null);
    const selectionKey = `${props.profile.id}:${activeEnvVarName}:${props.machineId ?? 'no-machine'}`;
    const [selectedSource, setSelectedSource] = React.useState<'machine' | 'saved' | 'once' | null>(() => {
        if (variant === 'defaultForProfile') return 'saved';
        const selectedRaw = props.selectedSecretIdByEnvVarName?.[activeEnvVarName];
        const hasSessionOnly = typeof props.sessionOnlySecretValueByEnvVarName?.[activeEnvVarName] === 'string'
            && String(props.sessionOnlySecretValueByEnvVarName?.[activeEnvVarName]).trim().length > 0;
        if (hasSessionOnly) return 'once';
        if (selectedRaw === '') return 'machine';
        if (typeof selectedRaw === 'string' && selectedRaw.trim().length > 0) return 'saved';
        // Default later once machine-env status is known.
        return null;
    });

    const [localDefaultSecretId, setLocalDefaultSecretId] = React.useState<string | null>(() => {
        const byName = props.defaultSecretIdByEnvVarName?.[activeEnvVarName];
        if (typeof byName === 'string') return byName;
        return props.defaultSecretId ?? null;
    });

    const machineHasRequiredSecret = React.useMemo(() => {
        if (!props.machineId) return null;
        if (!activeEnvVarName) return null;
        if (envPresence.isLoading) return null;
        if (!envPresence.isPreviewEnvSupported) return null;
        return Boolean(envPresence.meta[activeEnvVarName]?.isSet);
    }, [activeEnvVarName, envPresence.isLoading, envPresence.isPreviewEnvSupported, envPresence.meta, props.machineId]);

    const machineName = React.useMemo(() => {
        if (!props.machineId) return null;
        if (!machine) return props.machineId;
        return machine.metadata?.displayName || machine.metadata?.host || machine.id;
    }, [machine, props.machineId]);

    const machineNameColor = React.useMemo(() => {
        if (!props.machineId) return theme.colors.textSecondary;
        if (!machine) return theme.colors.textSecondary;
        return isMachineOnline(machine) ? theme.colors.status.connected : theme.colors.status.disconnected;
    }, [machine, props.machineId, theme.colors.status.connected, theme.colors.status.disconnected, theme.colors.textSecondary]);

    const allowedSources = React.useMemo(() => {
        const sources: Array<'machine' | 'saved' | 'once'> = [];
        if (variant === 'defaultForProfile') {
            sources.push('saved');
            return sources;
        }
        if (props.machineId) sources.push('machine');
        sources.push('saved');
        if (props.allowSessionOnly !== false) sources.push('once');
        return sources;
    }, [props.allowSessionOnly, props.machineId, variant]);

    React.useEffect(() => {
        if (selectedSource && allowedSources.includes(selectedSource)) return;
        if (variant === 'defaultForProfile') {
            setSelectedSource('saved');
            return;
        }
        setSelectedSource(null);
    }, [allowedSources, localDefaultSecretId, props.defaultSecretId, props.machineId, selectedSource, variant]);

    React.useEffect(() => {
        if (!selectedSource) return;
        secretRequirementSelectionMemory.set(selectionKey, selectedSource);
    }, [selectionKey, selectedSource]);

    // When "Use once" is selected, focus the input. This avoids cases where touch handling
    // inside nested modal/list layouts makes the TextInput hard to focus.
    React.useEffect(() => {
        if (selectedSource !== 'once') return;
        const id = setTimeout(() => {
            sessionOnlyInputRef.current?.focus();
        }, 50);
        return () => clearTimeout(id);
    }, [selectedSource]);

    const machineEnvTitle = React.useMemo(() => {
        const envName = activeEnvVarName || t('profiles.requirements.secretRequired');
        if (!props.machineId) return t('profiles.requirements.machineEnvStatus.checkFor', { env: envName });
        const target = machineName ?? t('profiles.requirements.machineEnvStatus.theMachine');
        if (envPresence.isLoading) return t('profiles.requirements.machineEnvStatus.checking', { env: envName });
        if (machineHasRequiredSecret) return t('profiles.requirements.machineEnvStatus.found', { env: envName, machine: target });
        return t('profiles.requirements.machineEnvStatus.notFound', { env: envName, machine: target });
    }, [activeEnvVarName, envPresence.isLoading, machineHasRequiredSecret, machineName, props.machineId]);

    const machineEnvSubtitle = React.useMemo(() => {
        if (!props.machineId) return undefined;
        if (envPresence.isLoading) return t('profiles.requirements.machineEnvSubtitle.checking');
        if (machineHasRequiredSecret) return t('profiles.requirements.machineEnvSubtitle.found');
        return t('profiles.requirements.machineEnvSubtitle.notFound');
    }, [envPresence.isLoading, machineHasRequiredSecret, props.machineId]);

    const activeSelectedSavedSecretId = React.useMemo(() => {
        const selectedRaw = props.selectedSecretIdByEnvVarName?.[activeEnvVarName];
        if (typeof selectedRaw === 'string' && selectedRaw.trim().length > 0 && selectedRaw !== '') {
            return selectedRaw;
        }
        if (activeEnvVarName === normalizedSecretEnvVarName) {
            return props.selectedSavedSecretId ?? null;
        }
        return null;
    }, [activeEnvVarName, normalizedSecretEnvVarName, props.selectedSavedSecretId, props.selectedSecretIdByEnvVarName]);

    const activeDefaultSecretId = React.useMemo(() => {
        const byName = props.defaultSecretIdByEnvVarName?.[activeEnvVarName];
        if (typeof byName === 'string' && byName.trim().length > 0) return byName;
        if (activeEnvVarName === normalizedSecretEnvVarName) return props.defaultSecretId ?? null;
        return null;
    }, [activeEnvVarName, normalizedSecretEnvVarName, props.defaultSecretId, props.defaultSecretIdByEnvVarName]);

    const [showChoiceDropdown, setShowChoiceDropdown] = React.useState(false);
    const [showEnvVarDropdown, setShowEnvVarDropdown] = React.useState(false);

    // If the machine env option is disabled, never show it as the selected option.
    React.useEffect(() => {
        if (variant !== 'requirement') return;
        if (selectedSource === 'machine' && machineHasRequiredSecret !== true) {
            setSelectedSource('saved');
        }
        // If nothing has been selected yet, default to the first enabled option.
        if (selectedSource === null) {
            // Precedence (no explicit session override):
            // - default saved secret (if set) wins
            // - else machine env (if detected) wins
            // - else saved secret option
            if (activeDefaultSecretId) {
                setSelectedSource('saved');
                return;
            }
            if (props.machineId && machineHasRequiredSecret === true) {
                setSelectedSource('machine');
                return;
            }
            setSelectedSource('saved');
        }
    }, [activeDefaultSecretId, machineHasRequiredSecret, props.machineId, selectedSource, variant]);

    React.useEffect(() => {
        // When switching which env var we're resolving, restore any stored session-only value
        // and default the source based on current state.
        const nextSessionOnly = props.sessionOnlySecretValueByEnvVarName?.[activeEnvVarName];
        setSessionOnlyValue(typeof nextSessionOnly === 'string' ? nextSessionOnly : '');

        const selectedRaw = props.selectedSecretIdByEnvVarName?.[activeEnvVarName];
        const hasSessionOnly = typeof nextSessionOnly === 'string' && nextSessionOnly.trim().length > 0;
        if (variant === 'defaultForProfile') {
            setSelectedSource('saved');
            return;
        }
        if (hasSessionOnly) {
            setSelectedSource('once');
            return;
        }
        if (selectedRaw === '') {
            setSelectedSource('machine');
            return;
        }
        if (typeof selectedRaw === 'string' && selectedRaw.trim().length > 0) {
            setSelectedSource('saved');
            return;
        }
        if (activeDefaultSecretId) {
            setSelectedSource('saved');
            return;
        }
        if (props.machineId && machineHasRequiredSecret === true) {
            setSelectedSource('machine');
            return;
        }
        setSelectedSource('saved');
    }, [
        activeDefaultSecretId,
        activeEnvVarName,
        machineHasRequiredSecret,
        props.machineId,
        props.selectedSecretIdByEnvVarName,
        props.sessionOnlySecretValueByEnvVarName,
        variant,
    ]);

    return (
        <View style={[layoutVariant === 'screen' ? styles.containerScreen : styles.container, { maxHeight }]}>
            <View
                style={styles.header}
                onLayout={(e) => {
                    const next = e?.nativeEvent?.layout?.height ?? 0;
                    if (typeof next === 'number' && next > 0 && next !== headerHeight) {
                        setHeaderHeight(next);
                    }
                }}
            >
                <View style={{ flex: 1 }}>
                    <Text style={styles.headerTitle}>
                        {props.titleOverride ?? t('profiles.requirements.modalTitle')}
                    </Text>
                    <Text style={styles.headerSubtitle} numberOfLines={1}>
                        {props.profile.name}
                    </Text>
                </View>
                <Pressable
                    onPress={props.onClose}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
                >
                    <Ionicons name="close" size={20} color={theme.colors.textSecondary} />
                </Pressable>
            </View>

            <View ref={popoverBoundaryRef} style={[styles.scrollWrap, { maxHeight: scrollMaxHeight }]}>
                <ScrollView
                    style={[styles.scroll, { maxHeight: scrollMaxHeight }]}
                    contentContainerStyle={styles.scrollContent}
                    keyboardShouldPersistTaps="handled"
                    showsVerticalScrollIndicator={true}
                    scrollEventThrottle={32}
                    onLayout={fades.onViewportLayout}
                    onContentSizeChange={fades.onContentSizeChange}
                    onScroll={fades.onScroll}
                >
                {variant === 'requirement' ? (
                    <View style={styles.helpContainer}>
                        <Text style={styles.helpText}>
                            {activeEnvVarName
                                ? t('profiles.requirements.modalHelpWithEnv', { env: activeEnvVarName })
                                : t('profiles.requirements.modalHelpGeneric')}
                        </Text>
                    </View>
                ) : null}

                <ItemListStatic style={{ backgroundColor: 'transparent' }} containerStyle={{ paddingTop: 0 }}>
                    {variant === 'requirement' && secretEnvVarNames.length > 1 ? (
                        <ItemGroup title="" containerStyle={{ backgroundColor: 'transparent' }}>
                            <DropdownMenu
                                open={showEnvVarDropdown}
                                onOpenChange={setShowEnvVarDropdown}
                                variant="selectable"
                                search={false}
                                selectedId={activeEnvVarName}
                                showCategoryTitles={false}
                                matchTriggerWidth={true}
                                connectToTrigger={true}
                                rowKind="item"
                                popoverBoundaryRef={screenPopoverBoundaryRef}
                                popoverPortalWebTarget="body"
                                trigger={({ open, toggle }) => (
                                    <View
                                        style={[
                                            open
                                                ? (Platform.OS === 'web'
                                                    ? ({
                                                        boxShadow: theme.dark
                                                            ? '0 0px 3.84px rgba(0, 0, 0, 0.30), 0 3px 3.84px rgba(0, 0, 0, 0.30)'
                                                            : '0 0px 3.84px rgba(0, 0, 0, 0.08), 0 3px 3.84px rgba(0, 0, 0, 0.08)',
                                                    } as any)
                                                    : ({
                                                        shadowColor: theme.colors.shadow.color,
                                                        shadowOffset: { width: 0, height: 1 },
                                                        shadowRadius: 3.84,
                                                        shadowOpacity: theme.colors.shadow.opacity * 0.8,
                                                        elevation: 5,
                                                    } as any))
                                                : null,
                                            {
                                                borderRadius: 12,
                                                borderBottomLeftRadius: open ? 0 : 12,
                                                borderBottomRightRadius: open ? 0 : 12,
                                                backgroundColor: open
                                                    ? (theme.dark ? theme.colors.surfaceHighest : theme.colors.surfaceHigh)
                                                    : theme.colors.surface,
                                            },
                                        ]}
                                    >
                                        <Item
                                            selected={false}
                                            title={activeEnvVarName}
                                            subtitle={t('profiles.requirements.modalHelpWithEnv', { env: activeEnvVarName })}
                                            icon={<Ionicons name="key-outline" size={24} color={theme.colors.textSecondary} />}
                                            rightElement={(
                                                <Ionicons
                                                    name={open ? 'chevron-up' : 'chevron-down'}
                                                    size={20}
                                                    color={theme.colors.textSecondary}
                                                />
                                            )}
                                            showChevron={false}
                                            showDivider={false}
                                            onPress={toggle}
                                            pressableStyle={{
                                                borderRadius: 12,
                                                borderBottomLeftRadius: open ? 0 : 12,
                                                borderBottomRightRadius: open ? 0 : 12,
                                                overflow: 'hidden',
                                            }}
                                        />
                                    </View>
                                )}
                                items={secretEnvVarNames.map((name) => ({
                                    id: name,
                                    title: name,
                                    subtitle: undefined,
                                    icon: (
                                        <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                            <Ionicons name="key-outline" size={24} color={theme.colors.textSecondary} />
                                        </View>
                                    ),
                                }))}
                                onSelect={(id) => {
                                    setActiveEnvVarName(id);
                                }}
                            />
                        </ItemGroup>
                    ) : null}
                    {variant === 'requirement' ? (
                        <ItemGroup title={t('profiles.requirements.chooseOptionTitle')} containerStyle={{ backgroundColor: 'transparent' }}>
                            <DropdownMenu
                                open={showChoiceDropdown}
                                onOpenChange={setShowChoiceDropdown}
                                variant="selectable"
                                search={false}
                                selectedId={selectedSource}
                                showCategoryTitles={false}
                                matchTriggerWidth={true}
                                connectToTrigger={true}
                                rowKind="item"
                                popoverBoundaryRef={screenPopoverBoundaryRef}
                                popoverPortalWebTarget="body"
                                trigger={({ open, toggle }) => (
                                    <View
                                        style={[
                                            // When open, use the same shadow "strength" as FloatingOverlay, but bias it
                                            // upward so the trigger is visually separated from the background.
                                            open
                                                ? (Platform.OS === 'web'
                                                    ? ({
                                                        boxShadow: theme.dark
                                                            ? '0 0px 3.84px rgba(0, 0, 0, 0.30), 0 3px 3.84px rgba(0, 0, 0, 0.30)'
                                                            : '0 0px 3.84px rgba(0, 0, 0, 0.08), 0 3px 3.84px rgba(0, 0, 0, 0.08)',
                                                    } as any)
                                                    : ({
                                                        shadowColor: theme.colors.shadow.color,
                                                        shadowOffset: { width: 0, height: 1 },
                                                        shadowRadius: 3.84,
                                                        shadowOpacity: theme.colors.shadow.opacity * 0.8,
                                                        elevation: 5,
                                                    } as any))
                                                : null,
                                            {
                                                borderRadius: 12,
                                                borderBottomLeftRadius: open ? 0 : 12,
                                                borderBottomRightRadius: open ? 0 : 12,
                                                backgroundColor: open
                                                    ? (theme.dark ? theme.colors.surfaceHighest : theme.colors.surfaceHigh)
                                                    : theme.colors.surface,
                                            },
                                        ]}
                                    >
                                        <Item
                                            // Provide `selected={false}` so Item can apply "selectable hover" affordances on web.
                                            selected={false}
                                            title={
                                                selectedSource === 'saved'
                                                    ? t('profiles.requirements.options.useSavedSecret.title')
                                                    : selectedSource === 'once'
                                                        ? t('profiles.requirements.options.enterOnce.title')
                                                    : selectedSource === 'machine'
                                                        ? machineEnvTitle
                                                        : t('profiles.requirements.chooseOptionTitle')
                                            }
                                            subtitle={
                                                selectedSource === 'saved'
                                                    ? t('profiles.requirements.options.useSavedSecret.subtitle')
                                                    : selectedSource === 'once'
                                                        ? t('profiles.requirements.options.enterOnce.subtitle')
                                                    : selectedSource === 'machine'
                                                        ? machineEnvSubtitle
                                                        : undefined
                                            }
                                            icon={(
                                                <Ionicons
                                                    name={
                                                        selectedSource === 'saved'
                                                            ? 'key-outline'
                                                            : selectedSource === 'once'
                                                                ? 'flash-outline'
                                                            : selectedSource === 'machine'
                                                                ? 'desktop-outline'
                                                                : 'options-outline'
                                                    }
                                                    size={24}
                                                    color={theme.colors.textSecondary}
                                                />
                                            )}
                                            rightElement={(
                                                <Ionicons
                                                    name={open ? 'chevron-up' : 'chevron-down'}
                                                    size={20}
                                                    color={theme.colors.textSecondary}
                                                />
                                            )}
                                            showChevron={false}
                                            showDivider={false}
                                            onPress={toggle}
                                            pressableStyle={{
                                                borderRadius: 12,
                                                borderBottomLeftRadius: open ? 0 : 12,
                                                borderBottomRightRadius: open ? 0 : 12,
                                                // Keep clipping for rounded corners, but the shadow comes from the wrapper above.
                                                overflow: 'hidden',
                                            }}
                                        />
                                    </View>
                                )}
                                items={[
                                    ...(props.machineId ? [{
                                        id: 'machine',
                                        title: machineEnvTitle,
                                        subtitle: machineEnvSubtitle,
                                        icon: (
                                            <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                                <Ionicons name="desktop-outline" size={24} color={theme.colors.textSecondary} />
                                            </View>
                                        ),
                                        disabled: machineHasRequiredSecret !== true,
                                    }] : []),
                                    {
                                        id: 'saved',
                                        title: t('profiles.requirements.options.useSavedSecret.title'),
                                        subtitle: t('profiles.requirements.options.useSavedSecret.subtitle'),
                                        icon: (
                                            <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                                <Ionicons name="key-outline" size={24} color={theme.colors.textSecondary} />
                                            </View>
                                        ),
                                    },
                                    ...(props.allowSessionOnly !== false ? [{
                                        id: 'once',
                                        title: t('profiles.requirements.options.enterOnce.title'),
                                        subtitle: t('profiles.requirements.options.enterOnce.subtitle'),
                                        icon: (
                                            <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                                <Ionicons name="flash-outline" size={24} color={theme.colors.textSecondary} />
                                            </View>
                                        ),
                                    }] : []),
                                ]}
                                onSelect={(id) => {
                                    if (id === 'machine') {
                                        if (machineHasRequiredSecret === true) {
                                            setSelectedSource('machine');
                                            props.onResolve({ action: 'useMachine', envVarName: activeEnvVarName });
                                            props.onClose();
                                        }
                                        return;
                                    }
                                    setSelectedSource(id as any);
                                }}
                            />
                        </ItemGroup>
                    ) : null}

                    {selectedSource === 'saved' && (
                        <SecretsList
                            wrapInItemList={false}
                            secrets={props.secrets}
                            onChangeSecrets={(next) => props.onChangeSecrets?.(next)}
                            allowAdd={Boolean(props.onChangeSecrets)}
                            allowEdit
                            title={t('secrets.savedTitle')}
                            footer={null}
                            includeNoneRow={variant === 'defaultForProfile'}
                            noneSubtitle={variant === 'defaultForProfile' ? t('secrets.noneSubtitle') : undefined}
                            selectedId={variant === 'defaultForProfile'
                                ? (localDefaultSecretId ?? '')
                                : (activeSelectedSavedSecretId ?? '')
                            }
                            onSelectId={(id) => {
                                if (variant === 'defaultForProfile') {
                                    const current = localDefaultSecretId ?? null;
                                    const next = id === '' ? null : id;

                                    // UX: tapping the currently-selected default should unset it.
                                    if (next === current) {
                                        setLocalDefaultSecretId(null);
                                        props.onSetDefaultSecretId?.(null);
                                        props.onResolve({ action: 'cancel' });
                                        props.onClose();
                                        return;
                                    }

                                    setLocalDefaultSecretId(next);
                                    props.onSetDefaultSecretId?.(next);
                                    if (next) {
                                        props.onResolve({ action: 'selectSaved', envVarName: activeEnvVarName, secretId: next, setDefault: true });
                                    } else {
                                        props.onResolve({ action: 'cancel' });
                                    }
                                    props.onClose();
                                    return;
                                }
                                if (!id) return;
                                props.onResolve({ action: 'selectSaved', envVarName: activeEnvVarName, secretId: id, setDefault: false });
                                props.onClose();
                            }}
                            onAfterAddSelectId={(id) => {
                                if (variant === 'defaultForProfile') {
                                    setLocalDefaultSecretId(id);
                                    if (props.onSetDefaultSecretId) {
                                        props.onSetDefaultSecretId(id);
                                    }
                                    props.onResolve({ action: 'selectSaved', envVarName: activeEnvVarName, secretId: id, setDefault: true });
                                    props.onClose();
                                    return;
                                }
                                props.onResolve({ action: 'selectSaved', envVarName: activeEnvVarName, secretId: id, setDefault: false });
                                props.onClose();
                            }}
                        />
                    )}

                    {selectedSource === 'once' && props.allowSessionOnly !== false && (
                        <ItemGroup title={t('profiles.requirements.sections.useOnceTitle')} footer={t('profiles.requirements.sections.useOnceFooter')}>
                            <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 16 }}>
                                <Text style={styles.fieldLabel}>{t('profiles.requirements.sections.useOnceLabel')}</Text>
                                <TextInput
                                    ref={sessionOnlyInputRef}
                                    style={styles.textInput}
                                    placeholder="sk-..."
                                    placeholderTextColor={theme.colors.input.placeholder}
                                    value={sessionOnlyValue}
                                    onChangeText={setSessionOnlyValue}
                                    autoFocus={selectedSource === 'once'}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    secureTextEntry
                                    textContentType={Platform.OS === 'ios' ? 'password' : undefined}
                                />
                                <View style={{ height: 10 }} />
                                <Pressable
                                    disabled={!sessionOnlyValue.trim()}
                                    onPress={() => {
                                        const v = sessionOnlyValue.trim();
                                        if (!v) return;
                                        props.onResolve({ action: 'enterOnce', envVarName: activeEnvVarName, value: v });
                                        props.onClose();
                                    }}
                                    style={({ pressed }) => [
                                        styles.primaryButton,
                                        {
                                            opacity: !sessionOnlyValue.trim() ? 0.5 : (pressed ? 0.85 : 1),
                                            backgroundColor: theme.colors.button.primary.background,
                                        },
                                    ]}
                                >
                                    <Text style={[styles.primaryButtonText, { color: theme.colors.button.primary.tint }]}>
                                        {t('profiles.requirements.actions.useOnceButton')}
                                    </Text>
                                </Pressable>
                            </View>
                        </ItemGroup>
                    )}
                </ItemListStatic>
                </ScrollView>

                <ScrollEdgeFades
                    color={theme.colors.groupped.background}
                    size={18}
                    edges={fades.visibility}
                />
                <ScrollEdgeIndicators
                    edges={fades.visibility}
                    color={theme.colors.textSecondary}
                    size={14}
                    opacity={0.35}
                />
            </View>
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: '92%',
        maxWidth: 560,
        backgroundColor: theme.colors.groupped.background,
        borderRadius: 16,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: theme.colors.divider,
        flexShrink: 1,
        alignSelf: 'center',
    },
    containerScreen: {
        flex: 1,
        width: '100%',
        backgroundColor: theme.colors.groupped.background,
        borderRadius: 0,
        overflow: 'hidden',
        borderWidth: 0,
        borderColor: 'transparent',
        alignSelf: 'stretch',
    },
    header: {
        paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
        paddingTop: 14,
        paddingBottom: 12,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    headerTitle: {
        fontSize: 16,
        fontWeight: '700',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    headerSubtitle: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginTop: 2,
        ...Typography.default(),
    },
    scrollWrap: {
        position: 'relative',
    },
    scroll: {},
    scrollContent: {
        paddingBottom: 18,
    },
    helpContainer: {
        width: '100%',
        paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
        paddingTop: 14,
        paddingBottom: 8,
        alignSelf: 'center',
    },
    helpText: {
        ...Typography.default(),
        color: theme.colors.textSecondary,
        fontSize: Platform.select({ ios: 15, default: 14 }),
        lineHeight: 20,
        letterSpacing: Platform.select({ ios: -0.24, default: 0.1 }),
    },
    primaryButton: {
        borderRadius: 10,
        paddingVertical: 10,
        alignItems: 'center',
        justifyContent: 'center',
    },
    primaryButtonText: {
        fontSize: 13,
        fontWeight: '600',
        ...Typography.default('semiBold'),
    },
    fieldLabel: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.groupped.sectionTitle,
        marginBottom: 4,
    },
    textInput: {
        backgroundColor: theme.colors.input.background,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        paddingHorizontal: 12,
        paddingVertical: 10,
        color: theme.colors.text,
        ...Typography.default(),
    },
}));
