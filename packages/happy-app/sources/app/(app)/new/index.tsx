import React from 'react';
import {
    View,
    Text,
    Platform,
    Pressable,
    Modal as RNModal,
    TouchableWithoutFeedback,
    Animated,
    TextInput,
    ScrollView,
    LayoutAnimation,
    ActivityIndicator,
    TextInputSelectionChangeEventData,
    NativeSyntheticEvent,
    Image as RNImage,
    useWindowDimensions,
} from 'react-native';
import { GlassView } from 'expo-glass-effect';
import { Ionicons, Octicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation, useRouter } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';
import {
    MultiTextInput,
    MULTI_TEXT_INPUT_LINE_HEIGHT,
    type KeyPressEvent,
} from '@/components/MultiTextInput';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import Constants from 'expo-constants';
import { useHeaderHeight } from '@/utils/responsive';
import { t } from '@/text';
import { useAllMachines, useLocalSetting, useSessions, useSetting, storage } from '@/sync/storage';
import type { NewSessionAgentType } from '@/sync/persistence';
import { sync } from '@/sync/sync';
import { isMachineOnline } from '@/utils/machineUtils';
import { machineSpawnNewSession } from '@/sync/ops';
import { createWorktree, listWorktrees } from '@/utils/worktree';
import { resolveAbsolutePath } from '@/utils/pathUtils';
import { formatPathRelativeToHome, formatLastSeen } from '@/utils/sessionUtils';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { useNewSessionDraft } from '@/hooks/useNewSessionDraft';
import { useShallow } from 'zustand/react/shallow';
import type { MultiTextInputHandle } from '@/components/MultiTextInput';
import { Modal } from '@/modal';
import type { Machine, Session } from '@/sync/storageTypes';
import {
    getHardcodedPermissionModes,
    getHardcodedModelModes,
    getEffortLevelsForModel,
    getSupportsWorktree,
    type PermissionMode,
    type ModelMode,
    type EffortLevel,
} from '@/components/modelModeOptions';
import { isRunningOnMac } from '@/utils/platform';
import { getNewSessionSidebarLayout } from '@/utils/newSessionSidebarLayout';
import { getAgentPickerItems, getModePickerItems } from '@/utils/newSessionPickerItems';
import { resolveAgentDefaultConfig } from '@/sync/agentDefaults';

// Agent icon assets
const agentIcons = {
    claude: require('@/assets/images/icon-claude.png'),
    codex: require('@/assets/images/icon-gpt.png'),
    openclaw: require('@/assets/images/icon-openclaw.png'),
    gemini: require('@/assets/images/icon-gemini.png'),
};

type AgentKey = NewSessionAgentType;
const ALL_AGENTS: { key: AgentKey; label: string }[] = [
    { key: 'claude', label: 'claude code' },
    { key: 'codex', label: 'codex' },
    { key: 'openclaw', label: 'openclaw' },
    { key: 'gemini', label: 'gemini' },
];

type PickerItem = { key: string; label: string; subtitle?: string; dimmed?: boolean };

type PickerType = 'machine' | 'path' | 'worktree' | 'agent' | 'model' | 'effort' | 'permission';

type PermissionStyle = { color: string; icon: 'play-forward' | 'pause' };

const COMPOSER_INPUT_VERTICAL_PADDING = Platform.OS === 'web' ? 10 : 8;
// Taller composer on web/desktop where vertical space is plentiful; keep the
// compact cap on native mobile so the input doesn't dominate the screen.
const COMPOSER_INPUT_MAX_HEIGHT = Platform.OS === 'web' ? 480 : 240;
const COMPOSER_SEND_BUTTON_SIZE = 32;
const WORKTREE_PATH_DEBOUNCE_MS = 300;

function trimPathInput(path: string | null | undefined): string {
    return path?.trim() ?? '';
}

function trimTrailingPathSeparator(path: string): string {
    if (path === '/' || /^[A-Za-z]:[\\/]?$/.test(path)) {
        return path;
    }
    return path.replace(/[\\/]+$/, '');
}

function normalizePathForComparison(path: string | null | undefined, homeDir?: string): string | null {
    const trimmed = trimPathInput(path);
    if (!trimmed) {
        return null;
    }
    return trimTrailingPathSeparator(resolveAbsolutePath(trimmed, homeDir));
}

function getPermissionStyle(key: string): PermissionStyle | null {
    switch (key) {
        case 'acceptEdits':
        case 'auto_edit':
            return { color: '#A78BFA', icon: 'play-forward' };
        case 'plan':
            return { color: '#5EABA4', icon: 'pause' };
        case 'dontAsk':
        case 'safe-yolo':
            return { color: '#FBBF24', icon: 'play-forward' };
        case 'bypassPermissions':
        case 'yolo':
            return { color: '#F87171', icon: 'play-forward' };
        case 'read-only':
            return { color: '#60A5FA', icon: 'pause' };
        default:
            return null;
    }
}

// Bottom sheet modal — native formSheet on iOS, slide-up sheet on Android
function BottomSheet({
    visible,
    onClose,
    children,
}: {
    visible: boolean;
    onClose: () => void;
    children: React.ReactNode;
}) {
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();

    if (Platform.OS === 'ios') {
        return (
            <RNModal
                visible={visible}
                animationType="slide"
                presentationStyle="formSheet"
                onRequestClose={onClose}
            >
                <View style={[sheetStyles.iosContainer, { backgroundColor: theme.colors.header.background }]}>
                    <View style={sheetStyles.handleRow}>
                        <View style={[sheetStyles.handle, { backgroundColor: theme.colors.textSecondary }]} />
                    </View>
                    {children}
                    <View style={{ height: safeArea.bottom }} />
                </View>
            </RNModal>
        );
    }

    // Android: slide-up sheet with backdrop
    const fadeAnim = React.useRef(new Animated.Value(0)).current;
    const slideAnim = React.useRef(new Animated.Value(300)).current;

    React.useEffect(() => {
        if (visible) {
            Animated.parallel([
                Animated.timing(fadeAnim, { toValue: 1, duration: 250, useNativeDriver: true }),
                Animated.spring(slideAnim, { toValue: 0, damping: 25, stiffness: 300, useNativeDriver: true }),
            ]).start();
        } else {
            Animated.parallel([
                Animated.timing(fadeAnim, { toValue: 0, duration: 200, useNativeDriver: true }),
                Animated.timing(slideAnim, { toValue: 300, duration: 200, useNativeDriver: true }),
            ]).start();
        }
    }, [visible, fadeAnim, slideAnim]);

    return (
        <RNModal
            visible={visible}
            transparent
            animationType="none"
            onRequestClose={onClose}
        >
            <View style={sheetStyles.overlay}>
                <TouchableWithoutFeedback onPress={onClose}>
                    <Animated.View style={[sheetStyles.backdrop, { opacity: fadeAnim }]} />
                </TouchableWithoutFeedback>
                <Animated.View
                    style={[
                        sheetStyles.sheet,
                        {
                            backgroundColor: theme.colors.header.background,
                            paddingBottom: Math.max(16, safeArea.bottom),
                            transform: [{ translateY: slideAnim }],
                        },
                    ]}
                >
                    <View style={sheetStyles.handleRow}>
                        <View style={[sheetStyles.handle, { backgroundColor: theme.colors.textSecondary }]} />
                    </View>
                    {children}
                </Animated.View>
            </View>
        </RNModal>
    );
}

// Generic picker content — reused for machine, path, and worktree selection
function PickerContent({
    title,
    fixedItems,
    items,
    selectedKey,
    onSelect,
    searchPlaceholder,
    embedded = false,
}: {
    title: string;
    fixedItems?: PickerItem[];
    items: PickerItem[];
    selectedKey: string | null;
    onSelect: (key: string) => void;
    searchPlaceholder?: string;
    embedded?: boolean;
}) {
    const { theme } = useUnistyles();
    const [search, setSearch] = React.useState('');
    const shouldShowSearch = !embedded || items.length + (fixedItems?.length ?? 0) > 4;

    const filtered = React.useMemo(() => {
        if (!shouldShowSearch || !search) return items;
        const q = search.toLowerCase();
        return items.filter(item => item.label.toLowerCase().includes(q));
    }, [shouldShowSearch, search, items]);

    const renderOption = (item: PickerItem) => {
        const isSelected = item.key === selectedKey;
        return (
            <Pressable
                key={item.key}
                style={(p) => [
                    pickerStyles.option,
                    embedded && pickerStyles.embeddedOption,
                    p.pressed && pickerStyles.optionPressed,
                    item.dimmed && { opacity: 0.45 },
                ]}
                onPress={() => onSelect(item.key)}
            >
                <Octicons
                    name={isSelected ? 'check-circle-fill' : 'circle'}
                    size={16}
                    color={isSelected ? theme.colors.button.primary.background : theme.colors.textSecondary}
                />
                <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[pickerStyles.optionText, { color: theme.colors.text }]} numberOfLines={1}>
                        {item.label}
                    </Text>
                    {item.subtitle && (
                        <Text style={[pickerStyles.optionText, { color: theme.colors.textSecondary, fontSize: 13 }]} numberOfLines={1}>
                            {item.subtitle}
                        </Text>
                    )}
                </View>
            </Pressable>
        );
    };

    return (
        <View style={[pickerStyles.container, embedded && pickerStyles.embeddedContainer]}>
            {!embedded && (
                <Text style={[pickerStyles.title, { color: theme.colors.text }]}>{title}</Text>
            )}

            {shouldShowSearch && (
                <View style={[
                    pickerStyles.searchRow,
                    { backgroundColor: embedded ? 'transparent' : theme.colors.input.background },
                    embedded && pickerStyles.embeddedSearchRow,
                ]}>
                    <Ionicons name="search" size={16} color={theme.colors.textSecondary} />
                    <TextInput
                        value={search}
                        onChangeText={setSearch}
                        placeholder={searchPlaceholder ?? 'search...'}
                        placeholderTextColor={theme.colors.textSecondary}
                        style={[pickerStyles.searchInput, { color: theme.colors.text }]}
                        autoCapitalize="none"
                        autoCorrect={false}
                    />
                </View>
            )}

            <ScrollView
                style={[pickerStyles.optionList, embedded && pickerStyles.embeddedOptionList]}
                contentContainerStyle={embedded && pickerStyles.embeddedOptionListContent}
                keyboardShouldPersistTaps="handled"
            >
                {fixedItems?.map(renderOption)}
                {fixedItems && fixedItems.length > 0 && filtered.length > 0 && (
                    <View style={[pickerStyles.divider, { backgroundColor: theme.colors.divider }]} />
                )}
                {filtered.map(renderOption)}
                {filtered.length === 0 && search.length > 0 && (
                    <Text style={[pickerStyles.emptyText, { color: theme.colors.textSecondary }]}>
                        no results
                    </Text>
                )}
            </ScrollView>
        </View>
    );
}

function PathPickerContent({
    title,
    items,
    value,
    homeDir,
    onChangeValue,
    onDone,
    embedded = false,
}: {
    title: string;
    items: PickerItem[];
    value: string | null;
    homeDir?: string;
    onChangeValue: (value: string) => void;
    onDone?: () => void;
    embedded?: boolean;
}) {
    const { theme } = useUnistyles();
    const inputRef = React.useRef<TextInput>(null);
    const currentValue = value ?? '';
    const [selection, setSelection] = React.useState<{ start: number; end: number } | undefined>(undefined);

    React.useEffect(() => {
        const timeout = setTimeout(() => {
            inputRef.current?.focus();
        }, 50);
        return () => clearTimeout(timeout);
    }, []);

    const matchedItemKey = React.useMemo(() => {
        const normalizedValue = normalizePathForComparison(currentValue, homeDir);
        if (!normalizedValue) {
            return null;
        }

        const match = items.find((item) =>
            normalizePathForComparison(item.key, homeDir) === normalizedValue,
        );

        return match?.key ?? null;
    }, [currentValue, homeDir, items]);

    const handleSuggestionPress = React.useCallback((item: PickerItem) => {
        const nextValue = item.label;
        const nextSelection = { start: nextValue.length, end: nextValue.length };

        onChangeValue(nextValue);
        setSelection(nextSelection);

        setTimeout(() => {
            inputRef.current?.focus();
        }, 0);
    }, [onChangeValue]);

    const isCustomPath = currentValue.trim().length > 0 && matchedItemKey === null;
    const handleSelectionChange = React.useCallback((event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
        setSelection(event.nativeEvent.selection);
    }, []);
    const doneIconColor = theme.colors.header.tint;

    return (
        <View style={[pickerStyles.container, embedded && pickerStyles.embeddedContainer]}>
            {!embedded && (
                <View style={pickerStyles.titleRow}>
                    <Text style={[pickerStyles.title, { color: theme.colors.text }]}>{title}</Text>
                    {Platform.OS !== 'web' && onDone && (
                        <Pressable
                            onPress={onDone}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                            style={({ pressed }) => [
                                pickerStyles.doneButtonPressable,
                                { opacity: pressed ? 0.82 : 1 },
                            ]}
                            accessibilityRole="button"
                            accessibilityLabel="Done"
                        >
                            <GlassView
                                glassEffectStyle="regular"
                                tintColor="rgba(255,255,255,0.10)"
                                isInteractive={true}
                                style={[
                                    pickerStyles.doneButtonGlass,
                                    { borderColor: 'rgba(255,255,255,0.16)' },
                                ]}
                            >
                                <Ionicons
                                    name="checkmark"
                                    size={20}
                                    color={doneIconColor}
                                />
                            </GlassView>
                        </Pressable>
                    )}
                </View>
            )}

            <View
                style={[
                    pickerStyles.pathInputRow,
                    {
                        backgroundColor: embedded ? 'transparent' : theme.colors.input.background,
                        borderColor: embedded ? 'transparent' : theme.colors.divider,
                    },
                    embedded && pickerStyles.embeddedPathInputRow,
                ]}
            >
                <Ionicons name="folder-outline" size={16} color={theme.colors.textSecondary} />
                <View style={pickerStyles.pathInputField}>
                    <TextInput
                        ref={inputRef}
                        value={currentValue}
                        onChangeText={onChangeValue}
                        onSelectionChange={handleSelectionChange}
                        selection={selection}
                        placeholder="Enter project path"
                        placeholderTextColor={theme.colors.textSecondary}
                        style={[
                            pickerStyles.pathTextInput,
                            embedded && pickerStyles.embeddedPathTextInput,
                            { color: theme.colors.text },
                        ]}
                        autoCapitalize="none"
                        autoCorrect={false}
                        multiline={false}
                        numberOfLines={1}
                        returnKeyType="done"
                        onSubmitEditing={onDone}
                    />
                </View>
            </View>

            {isCustomPath && (
                <Text style={[pickerStyles.pathMetaText, { color: theme.colors.textSecondary }]}>
                    using custom path above
                </Text>
            )}

            <Text style={[pickerStyles.sectionLabel, { color: theme.colors.textSecondary }]}>
                Recent
            </Text>

            <ScrollView
                style={[pickerStyles.optionList, embedded && pickerStyles.embeddedOptionList]}
                contentContainerStyle={embedded && pickerStyles.embeddedOptionListContent}
                keyboardShouldPersistTaps="handled"
            >
                {items.map((item) => {
                    const isSelected = item.key === matchedItemKey;

                    return (
                        <Pressable
                            key={item.key}
                            style={(p) => [
                                pickerStyles.option,
                                embedded && pickerStyles.embeddedOption,
                                p.pressed && pickerStyles.optionPressed,
                            ]}
                            onPress={() => handleSuggestionPress(item)}
                        >
                            <Ionicons
                                name="folder-outline"
                                size={16}
                                color={theme.colors.textSecondary}
                            />
                            <View style={{ flex: 1, minWidth: 0 }}>
                                <Text style={[pickerStyles.optionText, { color: theme.colors.text }]} numberOfLines={1}>
                                    {item.label}
                                </Text>
                            </View>
                            {isSelected && (
                                <Ionicons
                                    name="checkmark-circle"
                                    size={18}
                                    color={theme.colors.button.primary.background}
                                />
                            )}
                        </Pressable>
                    );
                })}

                {items.length === 0 && (
                    <Text style={[pickerStyles.emptyText, { color: theme.colors.textSecondary }]}>
                        no recent projects yet
                    </Text>
                )}
            </ScrollView>
        </View>
    );
}

// Helper: get machine display name
function getMachineName(machine: Machine): string {
    return machine.metadata?.displayName || machine.metadata?.host || 'unknown';
}

// Owns the `input` subscription so the parent screen can stay decoupled from
// keystroke-rate state changes. Memoized: parent re-renders (e.g. when
// `canSend` flips or a picker opens) won't force the input to re-render
// because all of its props are stable.
type PromptInputProps = {
    placeholder: string;
    onKeyPress?: (e: KeyPressEvent) => boolean;
};
const PromptInput = React.memo(React.forwardRef<MultiTextInputHandle, PromptInputProps>(
    function PromptInput(props, ref) {
        const value = useNewSessionDraft((s) => s.input);
        const onChangeText = useNewSessionDraft((s) => s.setInput);
        return (
            <MultiTextInput
                ref={ref}
                value={value}
                onChangeText={onChangeText}
                placeholder={props.placeholder}
                lineHeight={MULTI_TEXT_INPUT_LINE_HEIGHT}
                paddingTop={COMPOSER_INPUT_VERTICAL_PADDING}
                paddingBottom={COMPOSER_INPUT_VERTICAL_PADDING}
                maxHeight={COMPOSER_INPUT_MAX_HEIGHT}
                onKeyPress={props.onKeyPress}
            />
        );
    },
));

function NewSessionScreen() {
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const router = useRouter();
    const navigation = useNavigation();
    const navigateToSession = useNavigateToSession();

    // Real data sources
    const allMachines = useAllMachines({ includeOffline: true });
    const sessions = useSessions();
    const agentInputEnterToSend = useSetting('agentInputEnterToSend');
    const agentDefaultOverrides = useSetting('agentDefaultOverrides');
    const fileDiffsSidebarEnabled = useSetting('fileDiffsSidebar');
    const zenMode = useLocalSetting('zenMode');
    const { width: windowWidth } = useWindowDimensions();

    // Persisted draft state (survives navigation).
    //
    // We deliberately do NOT subscribe to `input` at the parent level here:
    // typing flips `input` on every keystroke, and a parent re-render would
    // cascade through the whole config box, machine/path pickers, and all
    // the heavy `useMemo`s below. Instead, the input subtree (PromptInput)
    // owns the subscription, the parent only listens to a derived
    // `hasText` boolean for the auto-collapse effect, and `handleSend`
    // reads the live value via `useNewSessionDraft.getState()` on demand.
    const draft = useNewSessionDraft(useShallow((s) => ({
        selectedMachineId: s.selectedMachineId,
        setMachineId: s.setMachineId,
        selectedPath: s.selectedPath,
        setPath: s.setPath,
        agentType: s.agentType,
        setAgentType: s.setAgentType,
        permissionMode: s.permissionMode,
        setPermissionMode: s.setPermissionMode,
        modelMode: s.modelMode,
        setModelMode: s.setModelMode,
        sessionType: s.sessionType,
        setSessionType: s.setSessionType,
        worktreeKey: s.worktreeKey,
        setWorktreeKey: s.setWorktreeKey,
    })));
    const hasText = useNewSessionDraft((s) => s.input.trim().length > 0);
    const selectedAgent = draft.agentType;
    const setSelectedAgent = draft.setAgentType;
    const selectedMachineId = draft.selectedMachineId;
    const setSelectedMachineId = draft.setMachineId;
    const selectedPath = draft.selectedPath;
    const setSelectedPath = draft.setPath;
    const [worktreeKey, setWorktreeKey] = React.useState<string>(
        draft.worktreeKey ?? (draft.sessionType === 'worktree' ? '__new__' : '__none__')
    );
    React.useEffect(() => {
        draft.setSessionType(worktreeKey !== '__none__' ? 'worktree' : 'simple');
        draft.setWorktreeKey(worktreeKey === '__none__' || worktreeKey === '__new__' ? null : worktreeKey);
    }, [worktreeKey]);

    // Local-only UI state (not persisted)
    const [permissionIndex, setPermissionIndex] = React.useState(0);
    const [modelIndex, setModelIndex] = React.useState(0);
    const [effortIndex, setEffortIndex] = React.useState(0);
    const [isSpawning, setIsSpawning] = React.useState(false);
    const [activePicker, setActivePicker] = React.useState<PickerType | null>(null);

    // Config collapse — auto-collapses when typing, expands when empty
    const [isConfigExpanded, setIsConfigExpanded] = React.useState(true);

    // Auto-select first machine when none selected (first-ever use, no draft)
    React.useEffect(() => {
        if (selectedMachineId) return;
        if (allMachines.length > 0) {
            setSelectedMachineId(allMachines[0].id);
        }
    }, [allMachines, selectedMachineId]);

    const selectedMachine = React.useMemo(
        () => allMachines.find(m => m.id === selectedMachineId) ?? null,
        [allMachines, selectedMachineId],
    );
    const selectedHomeDir = selectedMachine?.metadata?.homeDir;

    // Build machine picker items: online first, then offline
    const machineItems = React.useMemo<PickerItem[]>(() => {
        const sorted = [...allMachines].sort((a, b) => {
            const aOnline = isMachineOnline(a) ? 0 : 1;
            const bOnline = isMachineOnline(b) ? 0 : 1;
            return aOnline - bOnline;
        });
        return sorted.map(m => ({
            key: m.id,
            label: getMachineName(m),
            subtitle: isMachineOnline(m) ? t('status.online') : t('status.lastSeen', { time: formatLastSeen(m.activeAt, false) }),
            dimmed: !isMachineOnline(m),
        }));
    }, [allMachines]);

    // Build path items from session history for selected machine
    const pathItems = React.useMemo<PickerItem[]>(() => {
        if (!selectedMachineId || !sessions) return [];
        const paths = new Set<string>();
        for (const s of sessions) {
            if (typeof s === 'string') continue;
            const session = s as Session;
            if (session.metadata?.machineId === selectedMachineId && session.metadata?.path) {
                paths.add(session.metadata.path);
            }
        }
        const homeDir = selectedMachine?.metadata?.homeDir;
        return Array.from(paths).sort().map(p => ({
            key: p,
            label: formatPathRelativeToHome(p, homeDir),
        }));
    }, [selectedMachineId, sessions, selectedMachine]);

    // Auto-select first path when machine changes
    React.useEffect(() => {
        if (!selectedMachineId || selectedPath !== null) {
            return;
        }

        setSelectedPath(pathItems[0]?.label ?? '~');
    }, [selectedMachineId, pathItems, selectedPath, setSelectedPath]);

    const resolvedSelectedPath = React.useMemo(() => {
        return normalizePathForComparison(selectedPath, selectedHomeDir);
    }, [selectedHomeDir, selectedPath]);

    const [debouncedResolvedSelectedPath, setDebouncedResolvedSelectedPath] = React.useState<string | null>(resolvedSelectedPath);

    React.useEffect(() => {
        if (!resolvedSelectedPath) {
            setDebouncedResolvedSelectedPath(null);
            return;
        }

        const timeout = setTimeout(() => {
            setDebouncedResolvedSelectedPath(resolvedSelectedPath);
        }, WORKTREE_PATH_DEBOUNCE_MS);

        return () => clearTimeout(timeout);
    }, [resolvedSelectedPath]);

    // Fetch existing worktrees from the selected machine/path
    const [worktreeItems, setWorktreeItems] = React.useState<PickerItem[]>([]);
    React.useEffect(() => {
        if (!selectedMachineId || !debouncedResolvedSelectedPath) {
            setWorktreeItems([]);
            return;
        }
        if (!selectedMachine || !isMachineOnline(selectedMachine)) {
            setWorktreeItems([]);
            return;
        }
        let cancelled = false;
        listWorktrees(selectedMachineId, debouncedResolvedSelectedPath).then(worktrees => {
            if (cancelled) return;
            setWorktreeItems(worktrees.map(wt => ({
                key: wt.path,
                label: wt.branch,
                subtitle: wt.path,
            })));
        });
        return () => { cancelled = true; };
    }, [debouncedResolvedSelectedPath, selectedMachineId, selectedMachine]);

    React.useEffect(() => {
        if (worktreeKey === '__none__' || worktreeKey === '__new__') {
            return;
        }

        if (!worktreeItems.some((item) => item.key === worktreeKey)) {
            setWorktreeKey('__none__');
        }
    }, [worktreeItems, worktreeKey]);

    // Filter available agents based on CLI availability from machine metadata
    const availableAgents = React.useMemo(() => {
        const availability = selectedMachine?.metadata?.cliAvailability;
        if (!availability) return ALL_AGENTS;
        return ALL_AGENTS.filter(a => availability[a.key]);
    }, [selectedMachine]);

    // If current agent not available on this machine, switch to first available
    React.useEffect(() => {
        if (availableAgents.length > 0 && !availableAgents.find(a => a.key === selectedAgent)) {
            setSelectedAgent(availableAgents[0].key);
        }
    }, [availableAgents, selectedAgent, setSelectedAgent]);

    // Derive options from agent type
    const permissionModes = React.useMemo<PermissionMode[]>(
        () => getHardcodedPermissionModes(selectedAgent, t),
        [selectedAgent],
    );
    const modelModes = React.useMemo<ModelMode[]>(
        () => getHardcodedModelModes(selectedAgent, t),
        [selectedAgent],
    );

    const currentModel = modelModes[modelIndex] ?? modelModes[0];
    const currentModelKey = currentModel?.key ?? 'default';

    const effortLevels = React.useMemo<EffortLevel[]>(
        () => getEffortLevelsForModel(selectedAgent, currentModelKey),
        [selectedAgent, currentModelKey],
    );
    const effectiveAgentDefaults = React.useMemo(() => (
        resolveAgentDefaultConfig(agentDefaultOverrides, selectedAgent)
    ), [agentDefaultOverrides, selectedAgent]);

    const supportsWorktree = getSupportsWorktree(selectedAgent);
    const showModel = modelModes.length > 1;
    const showEffort = effortLevels.length > 0;
    const showPermission = permissionModes.length > 1;

    // Reset indices when agent/default settings change.
    React.useEffect(() => {
        const defaultPermIdx = permissionModes.findIndex(m => m.key === effectiveAgentDefaults.permissionMode);
        setPermissionIndex(defaultPermIdx >= 0 ? defaultPermIdx : 0);

        const defaultModelIdx = modelModes.findIndex(m => m.key === effectiveAgentDefaults.modelMode);
        setModelIndex(defaultModelIdx >= 0 ? defaultModelIdx : 0);

        if (!supportsWorktree) setWorktreeKey('__none__');
    }, [permissionModes, modelModes, supportsWorktree, effectiveAgentDefaults.permissionMode, effectiveAgentDefaults.modelMode]);

    // Reset effort when model changes
    React.useEffect(() => {
        const defaultEffort = effectiveAgentDefaults.effortLevel;
        if (defaultEffort && effortLevels.length > 0) {
            const idx = effortLevels.findIndex(e => e.key === defaultEffort);
            setEffortIndex(idx >= 0 ? idx : effortLevels.length - 1);
        } else {
            setEffortIndex(0);
        }
    }, [effectiveAgentDefaults.effortLevel, currentModelKey, effortLevels]);

    // Auto collapse config once when user starts typing (mobile only)
    // On desktop (web / Mac Catalyst) the panel stays expanded
    // Also skip collapsing on the initial render when draft text is restored
    const hasCollapsedOnceRef = React.useRef(false);
    const isInitialRef = React.useRef(true);
    const isDesktop = Platform.OS === 'web' || isRunningOnMac();
    React.useEffect(() => {
        if (isInitialRef.current) {
            isInitialRef.current = false;
            return;
        }
        if (isDesktop) return;
        if (hasText && !hasCollapsedOnceRef.current) {
            hasCollapsedOnceRef.current = true;
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
            setIsConfigExpanded(false);
        }
    }, [hasText]);


    const toggleConfig = React.useCallback(() => {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setActivePicker(null);
        setIsConfigExpanded(v => !v);
    }, []);

    const togglePicker = React.useCallback((type: PickerType) => {
        setActivePicker(v => v === type ? null : type);
    }, []);

    const isOffline = selectedMachine ? !isMachineOnline(selectedMachine) : false;
    const agent = availableAgents.find(a => a.key === selectedAgent) ?? ALL_AGENTS[0];
    const currentPermission = permissionModes[permissionIndex] ?? permissionModes[0];
    const currentEffort = effortLevels[effortIndex] ?? effortLevels[0];
    const permissionStyle = currentPermission?.key !== 'default' ? getPermissionStyle(currentPermission.key) : null;

    // Display values
    const machineName = selectedMachine ? getMachineName(selectedMachine) : 'Select machine';
    const pathName = trimPathInput(selectedPath)
        ? formatPathRelativeToHome(trimPathInput(selectedPath), selectedHomeDir)
        : '~';
    const worktreeLabel = worktreeKey === '__none__'
        ? 'no worktree'
        : worktreeKey === '__new__'
            ? 'new worktree'
            : worktreeItems.find(wt => wt.key === worktreeKey)?.label || worktreeKey;

    // Picker data derived from active picker type
    const pickerData = React.useMemo(() => {
        switch (activePicker) {
            case 'machine':
                return { title: 'Machine', items: machineItems, selectedKey: selectedMachineId, searchPlaceholder: 'search machines...' };
            case 'worktree':
                return { title: 'Worktree', fixedItems: WORKTREE_FIXED_ITEMS, items: worktreeItems, selectedKey: worktreeKey, searchPlaceholder: 'search worktrees...' };
            case 'agent':
                return { title: 'Agent', items: getAgentPickerItems(availableAgents), selectedKey: selectedAgent, searchPlaceholder: 'search agents...' };
            case 'model':
                return { title: 'Model', items: getModePickerItems(modelModes), selectedKey: currentModelKey, searchPlaceholder: 'search models...' };
            case 'effort':
                return { title: 'Effort', items: getModePickerItems(effortLevels), selectedKey: currentEffort?.key ?? null, searchPlaceholder: 'search efforts...' };
            case 'permission':
                return { title: 'Permissions', items: getModePickerItems(permissionModes), selectedKey: currentPermission?.key ?? null, searchPlaceholder: 'search permissions...' };
            default:
                return null;
        }
    }, [
        activePicker,
        availableAgents,
        currentEffort?.key,
        currentModelKey,
        currentPermission?.key,
        effortLevels,
        machineItems,
        modelModes,
        permissionModes,
        selectedAgent,
        selectedMachineId,
        worktreeKey,
        worktreeItems,
    ]);

    const handlePickerSelect = React.useCallback((key: string) => {
        switch (activePicker) {
            case 'machine':
                setSelectedMachineId(key);
                break;
            case 'worktree':
                setWorktreeKey(key);
                break;
            case 'agent':
                if (availableAgents.some((candidate) => candidate.key === key)) {
                    setSelectedAgent(key as NewSessionAgentType);
                }
                break;
            case 'model': {
                const next = modelModes.findIndex((mode) => mode.key === key);
                if (next >= 0) {
                    setModelIndex(next);
                    draft.setModelMode(modelModes[next]?.key ?? 'default');
                }
                break;
            }
            case 'effort': {
                const next = effortLevels.findIndex((level) => level.key === key);
                if (next >= 0) {
                    setEffortIndex(next);
                }
                break;
            }
            case 'permission': {
                const next = permissionModes.findIndex((mode) => mode.key === key);
                if (next >= 0) {
                    setPermissionIndex(next);
                    draft.setPermissionMode(permissionModes[next]?.key ?? 'default');
                }
                break;
            }
        }
        setActivePicker(null);
    }, [
        activePicker,
        availableAgents,
        draft.setModelMode,
        draft.setPermissionMode,
        effortLevels,
        modelModes,
        permissionModes,
        setSelectedAgent,
        setSelectedMachineId,
        setWorktreeKey,
    ]);

    // Spawn session handler
    const handleSend = React.useCallback(async (approvedNewDirectoryCreation: boolean = false) => {
        if (!selectedMachineId || !selectedMachine) {
            Modal.alert(t('common.error'), 'Please select a machine');
            return;
        }
        if (!isMachineOnline(selectedMachine)) {
            Modal.alert(t('common.error'), 'Machine is offline');
            return;
        }

        setIsSpawning(true);
        try {
            const pathToUse = trimPathInput(selectedPath) || '~';
            const absolutePath = resolveAbsolutePath(pathToUse, selectedMachine.metadata?.homeDir);

            // Handle worktree selection
            let spawnDirectory = absolutePath;
            if (worktreeKey === '__new__') {
                const worktreeResult = await createWorktree(selectedMachineId, absolutePath);
                if (!worktreeResult.success) {
                    Modal.alert(t('common.error'), worktreeResult.error || 'Failed to create worktree');
                    return;
                }
                spawnDirectory = worktreeResult.worktreePath;
            } else if (worktreeKey !== '__none__') {
                // Existing worktree — use its path directly
                spawnDirectory = worktreeKey;
            }

            const result = await machineSpawnNewSession({
                machineId: selectedMachineId,
                directory: spawnDirectory,
                approvedNewDirectoryCreation,
                agent: selectedAgent,
                // Forward the picker values so the daemon-spawned Claude
                // session starts in the chosen mode + effort instead of the
                // CLI's hardcoded 'yolo' + 'medium' defaults.
                permissionMode: currentPermission?.key,
                effort: currentEffort?.key,
            });

            switch (result.type) {
                case 'success':
                    await sync.refreshSessions();

                    // Store only per-session overrides. Matching the effective
                    // default stays null so future code default changes apply.
                    const permissionOverride = currentPermission.key === effectiveAgentDefaults.permissionMode
                        ? null
                        : currentPermission.key;
                    const modelOverride = currentModelKey === effectiveAgentDefaults.modelMode
                        ? null
                        : currentModelKey;
                    const currentEffortKey = currentEffort?.key ?? null;
                    const effortOverride = currentEffortKey === effectiveAgentDefaults.effortLevel
                        ? null
                        : currentEffortKey;
                    storage.getState().updateSessionPermissionMode(result.sessionId, permissionOverride);
                    storage.getState().updateSessionModelMode(result.sessionId, modelOverride);
                    storage.getState().updateSessionEffortLevel(result.sessionId, effortOverride);

                    // Pull live prompt and clear it. We read via getState() so this
                    // callback doesn't have to subscribe to `input` (which would
                    // re-render the screen on every keystroke).
                    const draftState = useNewSessionDraft.getState();
                    const trimmedPrompt = draftState.input.trim();
                    draftState.setInput('');

                    // Send initial message if provided
                    if (trimmedPrompt) {
                        await sync.sendMessage(result.sessionId, trimmedPrompt, { source: 'new_session' });
                    }

                    router.back();
                    navigateToSession(result.sessionId);
                    break;
                case 'requestToApproveDirectoryCreation': {
                    const approved = await Modal.confirm(
                        'Create Directory?',
                        `The directory '${result.directory}' does not exist. Would you like to create it?`,
                        { cancelText: t('common.cancel'), confirmText: t('common.create') },
                    );
                    if (approved) {
                        await handleSend(true);
                    }
                    break;
                }
                case 'error':
                    Modal.alert(t('common.error'), result.errorMessage);
                    break;
            }
        } catch (error) {
            const errorMessage = error instanceof Error
                ? error.message
                : 'Failed to start session';
            Modal.alert(t('common.error'), errorMessage);
        } finally {
            setIsSpawning(false);
        }
    }, [selectedMachineId, selectedMachine, selectedPath, selectedAgent, router, navigateToSession, currentPermission.key, currentModelKey, currentEffort?.key, effectiveAgentDefaults.permissionMode, effectiveAgentDefaults.modelMode, effectiveAgentDefaults.effortLevel, worktreeKey]);

    const canSend = selectedMachineId && selectedMachine && isMachineOnline(selectedMachine) && !isSpawning;
    const sidebarLayout = getNewSessionSidebarLayout({
        platform: Platform.OS,
        isMac: isRunningOnMac(),
        fileDiffsSidebarEnabled,
        zenMode,
        windowWidth,
    });
    React.useLayoutEffect(() => {
        navigation.setOptions({ headerShown: !sidebarLayout.showSidebar });
        return () => navigation.setOptions({ headerShown: true });
    }, [navigation, sidebarLayout.showSidebar]);

    // Handle Enter/Cmd+Enter to send on web
    const handleKeyPress = React.useCallback((event: KeyPressEvent): boolean => {
        if (Platform.OS === 'web' && event.key === 'Enter' && !event.shiftKey && agentInputEnterToSend) {
            if (canSend) {
                handleSend();
                return true;
            }
        }
        return false;
    }, [agentInputEnterToSend, canSend, handleSend]);

    // Auto-focus the text input when the composer mounts
    const composerInputRef = React.useRef<import('@/components/MultiTextInput').MultiTextInputHandle>(null);
    React.useEffect(() => {
        const timeout = setTimeout(() => {
            composerInputRef.current?.focus();
        }, 100);
        return () => clearTimeout(timeout);
    }, []);

    const renderActivePickerPopover = React.useCallback((type: PickerType) => {
        if (Platform.OS !== 'web' || activePicker !== type) {
            return null;
        }

        return (
            <View style={[
                styles.popover,
                sidebarLayout.showSidebar
                    ? styles.sidebarPopover
                    : { backgroundColor: theme.colors.header.background },
            ]}>
                {type === 'path' ? (
                    <PathPickerContent
                        title="Project"
                        items={pathItems}
                        value={selectedPath}
                        homeDir={selectedHomeDir}
                        onChangeValue={setSelectedPath}
                        onDone={() => setActivePicker(null)}
                        embedded={sidebarLayout.showSidebar}
                    />
                ) : pickerData ? (
                    <PickerContent
                        {...pickerData}
                        onSelect={handlePickerSelect}
                        embedded={sidebarLayout.showSidebar}
                    />
                ) : null}
            </View>
        );
    }, [
        activePicker,
        handlePickerSelect,
        pathItems,
        pickerData,
        selectedHomeDir,
        selectedPath,
        setSelectedPath,
        sidebarLayout.showSidebar,
        theme.colors.header.background,
    ]);

    const configContent = (
        <>
            <View style={[
                styles.configBox,
                activePicker && styles.configBoxWithPopover,
                sidebarLayout.showSidebar && styles.sidebarConfigBox,
            ]}>
                {sidebarLayout.showSidebar || isConfigExpanded ? (
                    <>
                        <View style={styles.configRowWithToggle}>
                            <Pressable
                                style={(p) => [
                                    styles.configRow,
                                    { flex: 1 },
                                    p.pressed && styles.configRowPressed,
                                ]}
                                onPress={() => togglePicker('machine')}
                            >
                                <Ionicons name="desktop-outline" size={15} color={theme.colors.textSecondary} />
                                <Text style={[styles.configLabel, styles.configValueText]} numberOfLines={1}>
                                    {machineName}
                                </Text>
                                <Ionicons name="chevron-down" size={13} color={theme.colors.textSecondary} />
                            </Pressable>
                            {!sidebarLayout.showSidebar && (
                                <Pressable
                                    onPress={toggleConfig}
                                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                    style={(p) => [styles.collapseToggle, p.pressed && styles.configRowPressed]}
                                >
                                    <Ionicons name="chevron-up" size={16} color={theme.colors.textSecondary} />
                                </Pressable>
                            )}
                        </View>
                        {renderActivePickerPopover('machine')}

                        {isOffline && (
                            <View style={styles.offlineHelp}>
                                <Ionicons name="cloud-offline-outline" size={14} color={theme.colors.status.disconnected} />
                                <View style={{ flex: 1 }}>
                                    <Text style={[styles.offlineHelpTitle, { color: theme.colors.status.disconnected }]}>
                                        {t('newSession.machineOffline')}
                                    </Text>
                                    <Text style={[styles.offlineHelpText, { color: theme.colors.textSecondary }]}>
                                        {t('machine.offlineHelp')}
                                        {'\n'}{t('newSession.switchMachinesHint')}
                                    </Text>
                                </View>
                            </View>
                        )}

                        <View style={{ opacity: isOffline ? 0.4 : 1 }} pointerEvents={isOffline ? 'none' : 'auto'}>
                            <Pressable
                                style={(p) => [styles.configRow, p.pressed && styles.configRowPressed]}
                                onPress={() => togglePicker('path')}
                            >
                                <Ionicons name="folder-outline" size={15} color={theme.colors.textSecondary} />
                                <Text style={[styles.configLabel, styles.configValueText]} numberOfLines={1}>
                                    {pathName}
                                </Text>
                                <Ionicons name="chevron-down" size={13} color={theme.colors.textSecondary} />
                            </Pressable>
                            {renderActivePickerPopover('path')}

                            <View style={styles.configRow}>
                                <Pressable
                                    onPress={() => togglePicker('agent')}
                                    style={(p) => [styles.configInlineField, p.pressed && styles.configRowPressed]}
                                >
                                    <RNImage
                                        source={agentIcons[agent.key]}
                                        style={[styles.agentIcon, { tintColor: theme.colors.textSecondary }]}
                                        resizeMode="contain"
                                    />
                                    <Text style={[styles.configLabel, styles.configInlineText]} numberOfLines={1}>
                                        {agent.label}
                                    </Text>
                                    <Ionicons name="chevron-down" size={12} color={theme.colors.textSecondary} />
                                </Pressable>

                                {showModel && (
                                    <>
                                        <Text style={[styles.configLabel, { color: theme.colors.textSecondary }]}>·</Text>
                                        <Pressable onPress={() => togglePicker('model')} style={(p) => [styles.configInlineField, p.pressed && styles.configRowPressed]}>
                                            <Text style={[styles.configLabel, styles.configInlineText, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                                                {currentModel.name}
                                            </Text>
                                            <Ionicons name="chevron-down" size={12} color={theme.colors.textSecondary} />
                                        </Pressable>
                                    </>
                                )}

                                {showEffort && (
                                    <>
                                        <Text style={[styles.configLabel, { color: theme.colors.textSecondary }]}>·</Text>
                                        <Pressable onPress={() => togglePicker('effort')} style={(p) => [styles.configInlineField, p.pressed && styles.configRowPressed]}>
                                            <Text style={[styles.configLabel, styles.configInlineText, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                                                {currentEffort?.name}
                                            </Text>
                                            <Ionicons name="chevron-down" size={12} color={theme.colors.textSecondary} />
                                        </Pressable>
                                    </>
                                )}
                            </View>
                            {renderActivePickerPopover('agent')}
                            {renderActivePickerPopover('model')}
                            {renderActivePickerPopover('effort')}

                            {showPermission && (
                                <Pressable
                                    style={(p) => [styles.configRow, p.pressed && styles.configRowPressed]}
                                    onPress={() => togglePicker('permission')}
                                >
                                    <Ionicons
                                        name={permissionStyle?.icon ?? 'shield-outline'}
                                        size={15}
                                        color={theme.colors.textSecondary}
                                    />
                                    <Text style={[styles.configLabel, styles.configValueText]} numberOfLines={1}>
                                        {currentPermission?.name}
                                    </Text>
                                    <Ionicons name="chevron-down" size={13} color={theme.colors.textSecondary} />
                                </Pressable>
                            )}
                            {renderActivePickerPopover('permission')}

                            {supportsWorktree && (
                                <>
                                    <Pressable
                                        style={(p) => [styles.configRow, p.pressed && styles.configRowPressed]}
                                        onPress={() => togglePicker('worktree')}
                                    >
                                        <MaterialCommunityIcons name="tree" size={15} color={theme.colors.textSecondary} />
                                        <Text style={[styles.configLabel, styles.configValueText]} numberOfLines={1}>
                                            {worktreeLabel}
                                        </Text>
                                        <Ionicons name="chevron-down" size={13} color={theme.colors.textSecondary} />
                                    </Pressable>
                                    {renderActivePickerPopover('worktree')}
                                </>
                            )}
                        </View>
                    </>
                ) : (
                    <>
                        <View style={styles.configRowWithToggle}>
                            <Pressable
                                style={(p) => [styles.collapsedRow, { flex: 1 }, p.pressed && styles.configRowPressed]}
                                onPress={() => togglePicker('path')}
                            >
                                <Ionicons name="folder-outline" size={15} color={theme.colors.textSecondary} />
                                <Text style={[styles.configLabel, { flex: 1 }]} numberOfLines={1}>
                                    {pathName}
                                </Text>
                            </Pressable>
                            <Pressable
                                onPress={toggleConfig}
                                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                style={(p) => [styles.collapseToggle, p.pressed && styles.configRowPressed]}
                            >
                                <Ionicons name="chevron-down" size={16} color={theme.colors.textSecondary} />
                            </Pressable>
                        </View>
                        {renderActivePickerPopover('path')}

                        <View style={styles.collapsedIconsRow}>
                            <Pressable
                                onPress={() => togglePicker('machine')}
                                hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                                style={(p) => [styles.collapsedIconButton, p.pressed && styles.configRowPressed]}
                            >
                                <Ionicons name="desktop-outline" size={14} color={isOffline ? theme.colors.status.disconnected : theme.colors.textSecondary} />
                            </Pressable>

                            <Pressable
                                onPress={() => togglePicker('agent')}
                                hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                                style={(p) => [styles.collapsedIconButton, p.pressed && styles.configRowPressed]}
                            >
                                <RNImage
                                    source={agentIcons[agent.key]}
                                    style={[styles.collapsedAgentIcon, { tintColor: theme.colors.textSecondary }]}
                                    resizeMode="contain"
                                />
                            </Pressable>

                            {showPermission && (
                                <Pressable
                                    onPress={() => togglePicker('permission')}
                                    hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                                    style={(p) => [styles.collapsedIconButton, p.pressed && styles.configRowPressed]}
                                >
                                    <Ionicons
                                        name={permissionStyle?.icon ?? 'shield-outline'}
                                        size={14}
                                        color={permissionStyle?.color ?? theme.colors.textSecondary}
                                    />
                                </Pressable>
                            )}

                            {supportsWorktree && (
                                <Pressable
                                    onPress={() => togglePicker('worktree')}
                                    hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                                    style={(p) => [styles.collapsedIconButton, p.pressed && styles.configRowPressed]}
                                >
                                    <MaterialCommunityIcons name="tree" size={14} color={theme.colors.textSecondary} />
                                </Pressable>
                            )}
                        </View>
                        {renderActivePickerPopover('machine')}
                        {renderActivePickerPopover('agent')}
                        {renderActivePickerPopover('permission')}
                        {renderActivePickerPopover('worktree')}

                        {isOffline && (
                            <View style={styles.offlineHelp}>
                                <Ionicons name="cloud-offline-outline" size={14} color={theme.colors.status.disconnected} />
                                <View style={{ flex: 1 }}>
                                    <Text style={[styles.offlineHelpTitle, { color: theme.colors.status.disconnected }]}>
                                        {t('newSession.machineOffline')}
                                    </Text>
                                    <Text style={[styles.offlineHelpText, { color: theme.colors.textSecondary }]}>
                                        {t('machine.offlineHelp')}
                                        {'\n'}{t('newSession.switchMachinesHint')}
                                    </Text>
                                </View>
                            </View>
                        )}
                    </>
                )}
            </View>
        </>
    );

    const composerNode = (
        <View style={styles.inputBox}>
            <View style={styles.inputField}>
                <PromptInput
                    ref={composerInputRef}
                    placeholder="What would you like to work on?"
                    onKeyPress={handleKeyPress}
                />
            </View>
            <View style={styles.actionButtonsContainer}>
                <View style={styles.actionButtonsLeft} />
                <View style={[
                    styles.sendButton,
                    isSpawning ? styles.sendButtonActive :
                    canSend ? styles.sendButtonActive : styles.sendButtonInactive,
                ]}>
                    <Pressable
                        style={(p) => [
                            styles.sendButtonInner,
                            p.pressed && styles.sendButtonInnerPressed,
                        ]}
                        hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                        disabled={!canSend}
                        onPress={() => handleSend()}
                    >
                        {isSpawning ? (
                            <ActivityIndicator
                                size="small"
                                color={theme.colors.button.primary.tint}
                            />
                        ) : (
                            <Octicons
                                name="arrow-up"
                                size={16}
                                color={theme.colors.button.primary.tint}
                                style={[
                                    styles.sendButtonIcon,
                                    { marginTop: Platform.OS === 'web' ? 2 : 0 },
                                ]}
                            />
                        )}
                    </Pressable>
                </View>
            </View>
        </View>
    );

    return (
        <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            keyboardVerticalOffset={Platform.OS === 'ios' && !sidebarLayout.showSidebar ? Constants.statusBarHeight + headerHeight : 0}
            style={styles.container}
        >
            {sidebarLayout.showSidebar ? (
                <View style={styles.desktopShell}>
                    {Platform.OS === 'web' && activePicker && (
                        <Pressable
                            style={styles.clickAwayBackdrop}
                            onPress={() => setActivePicker(null)}
                        />
                    )}
                    <View style={styles.desktopMain}>
                        <View style={styles.centeredComposerWrap}>
                            <View style={styles.desktopPromptCluster}>
                                <Text style={styles.desktopPromptTitle}>
                                    {t('newSession.title')}
                                </Text>
                                <View style={styles.composerWidthWrap}>
                                    {composerNode}
                                </View>
                            </View>
                        </View>
                    </View>
                    <View style={[styles.rightSidebar, { width: sidebarLayout.sidebarWidth }]}>
                        <ScrollView
                            style={styles.rightSidebarScroll}
                            contentContainerStyle={styles.rightSidebarContent}
                            keyboardShouldPersistTaps="handled"
                        >
                            {configContent}
                        </ScrollView>
                    </View>
                </View>
            ) : (
                <View style={styles.inner}>
                    <View style={styles.inlineConfigWrap}>
                        {configContent}
                    </View>

                    {Platform.OS === 'web' && activePicker && (
                        <Pressable
                            style={styles.clickAwayBackdropBehind}
                            onPress={() => setActivePicker(null)}
                        />
                    )}

                    <View style={{ flex: 1 }} />

                    <View style={styles.inlineComposerWrap}>
                        {composerNode}
                    </View>

                    <View style={{ height: Math.max(16, safeArea.bottom) }} />
                </View>
            )}

            {/* Native: picker bottom sheet */}
            {Platform.OS !== 'web' && (
                <BottomSheet
                    visible={!!activePicker}
                    onClose={() => setActivePicker(null)}
                >
                    {activePicker === 'path' ? (
                        <PathPickerContent
                            title="Project"
                            items={pathItems}
                            value={selectedPath}
                            homeDir={selectedHomeDir}
                            onChangeValue={setSelectedPath}
                            onDone={() => setActivePicker(null)}
                        />
                    ) : pickerData ? (
                        <PickerContent {...pickerData} onSelect={handlePickerSelect} />
                    ) : null}
                </BottomSheet>
            )}
        </KeyboardAvoidingView>
    );
}

const WORKTREE_FIXED_ITEMS: PickerItem[] = [
    { key: '__none__', label: 'no worktree' },
    { key: '__new__', label: 'new worktree' },
];

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.header.background,
    },
    inner: {
        flex: 1,
    },
    desktopShell: {
        flex: 1,
        flexDirection: 'row',
        position: 'relative',
    },
    desktopMain: {
        flex: 1,
        minWidth: 0,
    },
    centeredComposerWrap: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 12,
    },
    desktopPromptCluster: {
        width: '100%',
        alignItems: 'center',
        gap: 32,
        transform: [{ translateY: -28 }],
    },
    desktopPromptTitle: {
        fontSize: 30,
        lineHeight: 36,
        color: theme.colors.text,
        textAlign: 'center',
        ...Typography.default(),
        ...Platform.select({ web: { userSelect: 'none' } as any, default: {} }),
    },
    composerWidthWrap: {
        maxWidth: layout.maxWidth,
        width: '100%',
    },
    rightSidebar: {
        flexShrink: 0,
        alignSelf: 'stretch',
        backgroundColor: theme.colors.groupped.background,
        borderLeftWidth: StyleSheet.hairlineWidth,
        borderLeftColor: theme.colors.divider,
        zIndex: 2,
    },
    rightSidebarScroll: {
        flex: 1,
    },
    rightSidebarContent: {
        paddingHorizontal: 12,
        paddingTop: 12,
        paddingBottom: 16,
        gap: 8,
    },
    inlineConfigWrap: {
        maxWidth: layout.maxWidth,
        width: '100%',
        alignSelf: 'center',
        paddingHorizontal: 12,
        gap: 8,
        paddingTop: 12,
    },
    inlineComposerWrap: {
        maxWidth: layout.maxWidth,
        width: '100%',
        alignSelf: 'center',
        paddingHorizontal: 12,
        gap: 8,
    },
    clickAwayBackdrop: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 1,
    },
    clickAwayBackdropBehind: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: -1,
    },
    configBox: {
        backgroundColor: theme.colors.input.background,
        borderRadius: Platform.select({ default: 16, android: 20 }),
        paddingVertical: 4,
        paddingHorizontal: 4,
        overflow: 'hidden',
    },
    configBoxWithPopover: {
        overflow: 'visible',
    },
    sidebarConfigBox: {
        backgroundColor: 'transparent',
        borderRadius: 0,
        paddingVertical: 0,
        paddingHorizontal: 0,
        overflow: 'visible',
    },
    popover: {
        borderRadius: 12,
        paddingVertical: 4,
        marginTop: 4,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        ...Platform.select({
            web: {
                boxShadow: '0 4px 20px rgba(0, 0, 0, 0.12)',
            },
            default: {
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: 0.12,
                shadowRadius: 10,
                elevation: 8,
            },
        }),
    },
    sidebarPopover: {
        minWidth: 0,
        alignSelf: 'stretch',
        backgroundColor: 'transparent',
        borderRadius: 0,
        borderWidth: 0,
        overflow: 'hidden',
        paddingVertical: 0,
        marginTop: -2,
        marginRight: 6,
        marginBottom: 6,
        marginLeft: 24,
        ...Platform.select({
            web: {
                boxShadow: 'none',
            },
            default: {
                shadowOpacity: 0,
                elevation: 0,
            },
        }),
    },
    configRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minWidth: 0,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 12,
    },
    configRowWithToggle: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    collapseToggle: {
        paddingHorizontal: 12,
        paddingVertical: 10,
        justifyContent: 'center',
        alignItems: 'center',
    },
    collapsedRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 12,
    },
    collapsedIconsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
        paddingHorizontal: 4,
        paddingBottom: 8,
    },
    collapsedIconButton: {
        width: 34,
        height: 28,
        borderRadius: 8,
        justifyContent: 'center',
        alignItems: 'center',
    },
    flashLabel: {
        alignSelf: 'center',
        paddingVertical: 4,
    },
    flashLabelText: {
        fontSize: 12,
        ...Typography.default(),
    },
    configRowPressed: {
        opacity: 0.6,
    },
    agentIcon: {
        width: 15,
        height: 15,
    },
    collapsedAgentIcon: {
        width: 14,
        height: 14,
    },
    configLabel: {
        minWidth: 0,
        fontSize: 14,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
        ...Platform.select({ web: { userSelect: 'none' } as any, default: {} }),
    },
    configValueText: {
        flex: 1,
        flexShrink: 1,
    },
    configInlineField: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        minWidth: 0,
        flexShrink: 1,
    },
    configInlineText: {
        minWidth: 0,
        flexShrink: 1,
    },
    inputBox: {
        backgroundColor: theme.colors.input.background,
        borderRadius: Platform.select({ default: 16, android: 20 }),
        overflow: 'hidden',
        paddingVertical: 2,
        paddingBottom: 8,
        paddingHorizontal: 8,
    },
    inputField: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: 8,
        paddingRight: 8,
        paddingVertical: 4,
        minHeight: 40,
    },
    actionButtonsContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 0,
    },
    actionButtonsLeft: {
        flexDirection: 'row',
        gap: 8,
        flex: 1,
        overflow: 'hidden',
    },
    sendButton: {
        width: COMPOSER_SEND_BUTTON_SIZE,
        height: COMPOSER_SEND_BUTTON_SIZE,
        borderRadius: COMPOSER_SEND_BUTTON_SIZE / 2,
        justifyContent: 'center',
        alignItems: 'center',
        flexShrink: 0,
        marginLeft: 8,
    },
    sendButtonActive: {
        backgroundColor: theme.colors.button.primary.background,
    },
    sendButtonInactive: {
        backgroundColor: theme.colors.button.primary.disabled,
    },
    sendButtonInner: {
        width: '100%',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
    },
    sendButtonInnerPressed: {
        opacity: 0.7,
    },
    sendButtonIcon: {
        color: theme.colors.button.primary.tint,
    },
    offlineHelp: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 12,
    },
    offlineHelpTitle: {
        fontSize: 13,
        ...Typography.default('semiBold'),
        marginBottom: 4,
    },
    offlineHelpText: {
        fontSize: 12,
        lineHeight: 18,
        ...Typography.default(),
    },
}));

// Bottom sheet styles
const sheetStyles = {
    iosContainer: {
        flex: 1,
    } as const,
    handleRow: {
        alignItems: 'center' as const,
        paddingTop: 10,
        paddingBottom: 6,
    },
    handle: {
        width: 36,
        height: 4,
        borderRadius: 2,
        opacity: 0.3,
    },
    overlay: {
        flex: 1,
        justifyContent: 'flex-end' as const,
    },
    backdrop: {
        position: 'absolute' as const,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'black',
        opacity: 0.4,
    },
    sheet: {
        borderTopLeftRadius: 16,
        borderTopRightRadius: 16,
        maxHeight: '70%' as const,
    },
};

// Picker styles
const pickerStyles = {
    container: {
        paddingHorizontal: 16,
        paddingBottom: 8,
    } as const,
    embeddedContainer: {
        width: '100%',
        maxWidth: '100%',
        minWidth: 0,
        alignSelf: 'stretch',
        paddingHorizontal: 0,
        paddingBottom: 2,
    } as const,
    title: {
        fontSize: 18,
        paddingVertical: 12,
        paddingHorizontal: 4,
        ...Typography.default('semiBold'),
        ...Platform.select({ web: { userSelect: 'none' } as any, default: {} }),
    } as const,
    titleRow: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        justifyContent: 'space-between' as const,
    },
    doneButtonPressable: {
        width: 44,
        height: 44,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
    },
    doneButtonGlass: {
        width: 40,
        height: 36,
        borderRadius: 18,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        overflow: 'hidden' as const,
        borderWidth: 1,
        backgroundColor: 'rgba(255,255,255,0.08)',
    },
    searchRow: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 12,
        marginBottom: 8,
    },
    embeddedSearchRow: {
        width: '100%',
        minWidth: 0,
        paddingHorizontal: 4,
        paddingVertical: 8,
        borderRadius: 0,
        marginBottom: 4,
    } as const,
    searchInput: {
        flex: 1,
        minWidth: 0,
        fontSize: 15,
        padding: 0,
        ...Typography.default(),
        ...Platform.select({ web: { outlineStyle: 'none' } as any, default: {} }),
    } as const,
    pathInputRow: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: 10,
        paddingHorizontal: 12,
        minHeight: 46,
        borderRadius: 12,
        marginBottom: 8,
        borderWidth: 1,
    },
    embeddedPathInputRow: {
        width: '100%',
        minWidth: 0,
        paddingHorizontal: 4,
        minHeight: 38,
        borderRadius: 0,
        borderWidth: 0,
        marginBottom: 4,
    } as const,
    pathInputField: {
        flex: 1,
        minWidth: 0,
    } as const,
    pathTextInput: {
        fontSize: 16,
        minHeight: 44,
        paddingVertical: 0,
        ...Typography.default(),
        ...Platform.select({
            android: { textAlignVertical: 'center' as const },
            web: { outlineStyle: 'none' } as any,
            default: {},
        }),
    } as const,
    embeddedPathTextInput: {
        fontSize: 15,
        minHeight: 34,
    } as const,
    pathMetaText: {
        fontSize: 13,
        paddingHorizontal: 4,
        paddingBottom: 8,
        ...Typography.default(),
        ...Platform.select({ web: { userSelect: 'none' } as any, default: {} }),
    } as const,
    sectionLabel: {
        fontSize: 13,
        paddingHorizontal: 4,
        paddingBottom: 8,
        ...Typography.default('semiBold'),
        ...Platform.select({ web: { userSelect: 'none' } as any, default: {} }),
    } as const,
    option: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: 12,
        paddingHorizontal: 12,
        paddingVertical: 12,
        borderRadius: 12,
    },
    embeddedOption: {
        width: '100%',
        maxWidth: '100%',
        minWidth: 0,
        paddingHorizontal: 4,
        paddingVertical: 8,
        borderRadius: 0,
    } as const,
    optionPressed: {
        opacity: 0.6,
    } as const,
    optionText: {
        minWidth: 0,
        flexShrink: 1,
        fontSize: 15,
        ...Typography.default(),
        ...Platform.select({ web: { userSelect: 'none' } as any, default: {} }),
    } as const,
    divider: {
        height: 1,
        marginHorizontal: 12,
        marginVertical: 4,
    } as const,
    optionList: {
        flexGrow: 0,
        flexShrink: 1,
    } as const,
    embeddedOptionList: {
        width: '100%',
        maxWidth: '100%',
        minWidth: 0,
        maxHeight: 176,
    } as const,
    embeddedOptionListContent: {
        width: '100%',
        maxWidth: '100%',
        minWidth: 0,
    } as const,
    emptyText: {
        fontSize: 14,
        textAlign: 'center' as const,
        paddingVertical: 20,
        ...Typography.default(),
        ...Platform.select({ web: { userSelect: 'none' } as any, default: {} }),
    } as const,
};

export default React.memo(NewSessionScreen);
