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
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';
import { MultiTextInput, MULTI_TEXT_INPUT_LINE_HEIGHT } from '@/components/MultiTextInput';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import Constants from 'expo-constants';
import { useHeaderHeight } from '@/utils/responsive';
import { t } from '@/text';
import {
    getHardcodedPermissionModes,
    getHardcodedModelModes,
    getEffortLevelsForModel,
    getDefaultEffortKeyForModel,
    getDefaultPermissionModeKey,
    getDefaultModelKey,
    getSupportsWorktree,
    type PermissionMode,
    type ModelMode,
    type EffortLevel,
} from '@/components/modelModeOptions';

// Agent icon assets
const agentIcons = {
    claude: require('@/assets/images/icon-claude.png'),
    codex: require('@/assets/images/icon-gpt.png'),
    openclaw: require('@/assets/images/icon-openclaw.png'),
    gemini: require('@/assets/images/icon-gemini.png'),
};

type AgentKey = 'claude' | 'codex' | 'openclaw' | 'gemini';
const AGENTS: { key: AgentKey; label: string }[] = [
    { key: 'claude', label: 'claude code' },
    { key: 'codex', label: 'codex' },
    { key: 'openclaw', label: 'openclaw' },
    { key: 'gemini', label: 'gemini' },
];

// Sample data for pickers
type PickerItem = { key: string; label: string };

const SAMPLE_MACHINES: PickerItem[] = [
    { key: 'macbook', label: "Kirill's MacBook Pro" },
    { key: 'linux', label: 'dev-server-01' },
    { key: 'cloud', label: 'cloud-workstation' },
];

const SAMPLE_PATHS: PickerItem[] = [
    { key: 'happy', label: '~/projects/happy/happy' },
    { key: 'website', label: '~/projects/website' },
    { key: 'dotfiles', label: '~/dotfiles' },
];

const SAMPLE_WORKTREES: PickerItem[] = [
    { key: 'feat/auth-refactor', label: 'feat/auth-refactor' },
    { key: 'fix/login-bug', label: 'fix/login-bug' },
    { key: 'experiment/new-ui', label: 'experiment/new-ui' },
    { key: 'chore/upgrade-deps', label: 'chore/upgrade-deps' },
    { key: 'feat/dark-mode', label: 'feat/dark-mode' },
];

const WORKTREE_FIXED_ITEMS: PickerItem[] = [
    { key: '__none__', label: 'no worktree' },
    { key: '__new__', label: 'new worktree' },
];

type PickerType = 'machine' | 'path' | 'worktree';

// Permission mode colors & icons matching Claude Code CLI
type PermissionStyle = { color: string; icon: 'play-forward' | 'pause' };

const COMPOSER_INPUT_VERTICAL_PADDING = Platform.OS === 'web' ? 10 : 8;
const COMPOSER_SEND_BUTTON_SIZE = 32;
const COMPOSER_SEND_BUTTON_MARGIN_BOTTOM = Math.max(
    0,
    Math.round((MULTI_TEXT_INPUT_LINE_HEIGHT + COMPOSER_INPUT_VERTICAL_PADDING * 2 - COMPOSER_SEND_BUTTON_SIZE) / 2),
);

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
}: {
    title: string;
    fixedItems?: PickerItem[];
    items: PickerItem[];
    selectedKey: string | null;
    onSelect: (key: string) => void;
    searchPlaceholder?: string;
}) {
    const { theme } = useUnistyles();
    const [search, setSearch] = React.useState('');

    const filtered = React.useMemo(() => {
        if (!search) return items;
        const q = search.toLowerCase();
        return items.filter(item => item.label.toLowerCase().includes(q));
    }, [search, items]);

    const renderOption = (item: PickerItem) => {
        const isSelected = item.key === selectedKey;
        return (
            <Pressable
                key={item.key}
                style={(p) => [pickerStyles.option, p.pressed && pickerStyles.optionPressed]}
                onPress={() => onSelect(item.key)}
            >
                <Octicons
                    name={isSelected ? 'check-circle-fill' : 'circle'}
                    size={16}
                    color={isSelected ? theme.colors.button.primary.background : theme.colors.textSecondary}
                />
                <Text style={[pickerStyles.optionText, { color: theme.colors.text }]}>{item.label}</Text>
            </Pressable>
        );
    };

    return (
        <View style={pickerStyles.container}>
            <Text style={[pickerStyles.title, { color: theme.colors.text }]}>{title}</Text>

            <View style={[pickerStyles.searchRow, { backgroundColor: theme.colors.input.background }]}>
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

            <ScrollView style={{ maxHeight: 300 }} keyboardShouldPersistTaps="handled">
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

function SessionComposerDemo() {
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const headerHeight = useHeaderHeight();

    const [prompt, setPrompt] = React.useState('');
    const [selectedAgent, setSelectedAgent] = React.useState<AgentKey>('claude');
    const [permissionIndex, setPermissionIndex] = React.useState(0);
    const [modelIndex, setModelIndex] = React.useState(0);
    const [effortIndex, setEffortIndex] = React.useState(0);

    // Picker state — unified for machine, path, worktree
    const [selectedMachine, setSelectedMachine] = React.useState('macbook');
    const [selectedPath, setSelectedPath] = React.useState('happy');
    const [worktreeKey, setWorktreeKey] = React.useState('__none__');
    const [activePicker, setActivePicker] = React.useState<PickerType | null>(null);

    // Config collapse — auto-collapses when typing, expands when empty
    const [isConfigExpanded, setIsConfigExpanded] = React.useState(true);

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

    const supportsWorktree = getSupportsWorktree(selectedAgent);
    const showModel = modelModes.length > 1;
    const showEffort = effortLevels.length > 0;
    const showPermission = permissionModes.length > 1;

    // Reset indices when agent changes
    React.useEffect(() => {
        const defaultPermKey = getDefaultPermissionModeKey(selectedAgent);
        const permIdx = permissionModes.findIndex(m => m.key === defaultPermKey);
        setPermissionIndex(permIdx >= 0 ? permIdx : 0);

        const defaultModelKey = getDefaultModelKey(selectedAgent);
        const modelIdx = modelModes.findIndex(m => m.key === defaultModelKey);
        setModelIndex(modelIdx >= 0 ? modelIdx : 0);

        if (!supportsWorktree) setWorktreeKey('__none__');
    }, [selectedAgent, permissionModes, modelModes, supportsWorktree]);

    // Reset effort when model changes
    React.useEffect(() => {
        const defaultEffort = getDefaultEffortKeyForModel(selectedAgent, currentModelKey);
        if (defaultEffort && effortLevels.length > 0) {
            const idx = effortLevels.findIndex(e => e.key === defaultEffort);
            setEffortIndex(idx >= 0 ? idx : effortLevels.length - 1);
        } else {
            setEffortIndex(0);
        }
    }, [selectedAgent, currentModelKey, effortLevels]);

    const hasText = prompt.trim().length > 0;

    // Auto collapse/expand config based on input text
    const prevHasTextRef = React.useRef(false);
    React.useEffect(() => {
        if (hasText !== prevHasTextRef.current) {
            prevHasTextRef.current = hasText;
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
            setIsConfigExpanded(!hasText);
        }
    }, [hasText]);

    // Close any open picker when config collapses
    React.useEffect(() => {
        if (!isConfigExpanded) {
            setActivePicker(null);
        }
    }, [isConfigExpanded]);

    const toggleConfig = React.useCallback(() => {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setIsConfigExpanded(v => !v);
    }, []);

    const togglePicker = React.useCallback((type: PickerType) => {
        setActivePicker(v => v === type ? null : type);
    }, []);

    const cyclePermission = React.useCallback(() => {
        setPermissionIndex(i => (i + 1) % permissionModes.length);
    }, [permissionModes.length]);

    const cycleModel = React.useCallback(() => {
        setModelIndex(i => (i + 1) % modelModes.length);
    }, [modelModes.length]);

    const cycleEffort = React.useCallback(() => {
        setEffortIndex(i => (i + 1) % effortLevels.length);
    }, [effortLevels.length]);

    const cycleAgent = React.useCallback(() => {
        setSelectedAgent(prev => {
            const idx = AGENTS.findIndex(a => a.key === prev);
            return AGENTS[(idx + 1) % AGENTS.length].key;
        });
    }, []);

    const agent = AGENTS.find(a => a.key === selectedAgent)!;
    const currentPermission = permissionModes[permissionIndex] ?? permissionModes[0];
    const currentEffort = effortLevels[effortIndex] ?? effortLevels[0];
    const permissionStyle = currentPermission?.key !== 'default' ? getPermissionStyle(currentPermission.key) : null;

    // Display values
    const machineName = SAMPLE_MACHINES.find(m => m.key === selectedMachine)?.label ?? '';
    const pathName = SAMPLE_PATHS.find(p => p.key === selectedPath)?.label ?? '';
    const worktreeLabel = worktreeKey === '__none__'
        ? 'no worktree'
        : worktreeKey === '__new__'
            ? 'new worktree'
            : worktreeKey;

    // Picker data derived from active picker type
    const pickerData = React.useMemo(() => {
        switch (activePicker) {
            case 'machine':
                return { title: 'Machine', items: SAMPLE_MACHINES, selectedKey: selectedMachine, searchPlaceholder: 'search machines...' };
            case 'path':
                return { title: 'Project', items: SAMPLE_PATHS, selectedKey: selectedPath, searchPlaceholder: 'search projects...' };
            case 'worktree':
                return { title: 'Worktree', fixedItems: WORKTREE_FIXED_ITEMS, items: SAMPLE_WORKTREES, selectedKey: worktreeKey, searchPlaceholder: 'search worktrees...' };
            default:
                return null;
        }
    }, [activePicker, selectedMachine, selectedPath, worktreeKey]);

    const handlePickerSelect = React.useCallback((key: string) => {
        switch (activePicker) {
            case 'machine':
                setSelectedMachine(key);
                break;
            case 'path':
                setSelectedPath(key);
                break;
            case 'worktree':
                setWorktreeKey(key);
                break;
        }
        setActivePicker(null);
    }, [activePicker]);

    return (
        <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            keyboardVerticalOffset={Platform.OS === 'ios' ? Constants.statusBarHeight + headerHeight : 0}
            style={styles.container}
        >
            <View style={styles.inner}>
                <View style={{ maxWidth: layout.maxWidth, width: '100%', alignSelf: 'center', paddingHorizontal: 12, gap: 8, paddingTop: 12 }}>

                    {/* Config box */}
                    <View style={styles.configBox}>
                        {isConfigExpanded ? (
                            <>
                                {/* Machine row */}
                                <Pressable
                                    style={(p) => [styles.configRow, p.pressed && styles.configRowPressed]}
                                    onPress={() => togglePicker('machine')}
                                >
                                    <Ionicons name="desktop-outline" size={15} color={theme.colors.textSecondary} />
                                    <Text style={styles.configLabel} numberOfLines={1}>
                                        {machineName}
                                    </Text>
                                </Pressable>

                                {/* Path row */}
                                <Pressable
                                    style={(p) => [styles.configRow, p.pressed && styles.configRowPressed]}
                                    onPress={() => togglePicker('path')}
                                >
                                    <Ionicons name="folder-outline" size={15} color={theme.colors.textSecondary} />
                                    <Text style={styles.configLabel} numberOfLines={1}>
                                        {pathName}
                                    </Text>
                                </Pressable>

                                {/* Agent + model + effort row */}
                                <View style={styles.configRow}>
                                    <Pressable
                                        onPress={cycleAgent}
                                        style={(p) => [{ flexDirection: 'row', alignItems: 'center', gap: 8 }, p.pressed && styles.configRowPressed]}
                                    >
                                        <Image
                                            source={agentIcons[agent.key]}
                                            style={{ width: 15, height: 15 }}
                                            contentFit="contain"
                                            tintColor={theme.colors.textSecondary}
                                        />
                                        <Text style={styles.configLabel} numberOfLines={1}>
                                            {agent.label}
                                        </Text>
                                    </Pressable>

                                    {showModel && (
                                        <>
                                            <Text style={[styles.configLabel, { color: theme.colors.textSecondary }]}>·</Text>
                                            <Pressable onPress={cycleModel} style={(p) => [p.pressed && styles.configRowPressed]}>
                                                <Text style={[styles.configLabel, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                                                    {currentModel.name}
                                                </Text>
                                            </Pressable>
                                        </>
                                    )}

                                    {showEffort && (
                                        <>
                                            <Text style={[styles.configLabel, { color: theme.colors.textSecondary }]}>·</Text>
                                            <Pressable onPress={cycleEffort} style={(p) => [p.pressed && styles.configRowPressed]}>
                                                <Text style={[styles.configLabel, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                                                    {currentEffort?.name}
                                                </Text>
                                            </Pressable>
                                        </>
                                    )}
                                </View>

                                {/* Permission row */}
                                {showPermission && (
                                    <Pressable
                                        style={(p) => [styles.configRow, p.pressed && styles.configRowPressed]}
                                        onPress={cyclePermission}
                                    >
                                        <Ionicons
                                            name={permissionStyle?.icon ?? 'shield-outline'}
                                            size={15}
                                            color={theme.colors.textSecondary}
                                        />
                                        <Text style={styles.configLabel} numberOfLines={1}>
                                            {currentPermission?.name}
                                        </Text>
                                    </Pressable>
                                )}

                                {/* Worktree row */}
                                {supportsWorktree && (
                                    <Pressable
                                        style={(p) => [styles.configRow, p.pressed && styles.configRowPressed]}
                                        onPress={() => togglePicker('worktree')}
                                    >
                                        <Octicons name="git-branch" size={15} color={theme.colors.textSecondary} />
                                        <Text style={styles.configLabel} numberOfLines={1}>
                                            {worktreeLabel}
                                        </Text>
                                    </Pressable>
                                )}
                            </>
                        ) : (
                            /* Collapsed: path + chevron to re-expand */
                            <Pressable
                                style={(p) => [styles.collapsedRow, p.pressed && styles.configRowPressed]}
                                onPress={toggleConfig}
                            >
                                <Ionicons name="folder-outline" size={15} color={theme.colors.textSecondary} />
                                <Text style={[styles.configLabel, { flex: 1 }]} numberOfLines={1}>
                                    {pathName}
                                </Text>
                                <Ionicons name="chevron-down" size={16} color={theme.colors.textSecondary} />
                            </Pressable>
                        )}
                    </View>

                    {/* Web: inline popover */}
                    {Platform.OS === 'web' && activePicker && pickerData && (
                        <View style={[styles.popover, { backgroundColor: theme.colors.header.background }]}>
                            <PickerContent {...pickerData} onSelect={handlePickerSelect} />
                        </View>
                    )}
                </View>

                {/* Web: click-away backdrop */}
                {Platform.OS === 'web' && activePicker && (
                    <Pressable
                        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: -1 }}
                        onPress={() => setActivePicker(null)}
                    />
                )}

                {/* Spacer */}
                <View style={{ flex: 1 }} />

                <View style={{ maxWidth: layout.maxWidth, width: '100%', alignSelf: 'center', paddingHorizontal: 12, gap: 8 }}>
                    {/* Input box */}
                    <View style={styles.inputBox}>
                        <View style={styles.inputField}>
                            <View style={{ flex: 1 }}>
                                <MultiTextInput
                                    value={prompt}
                                    onChangeText={setPrompt}
                                    placeholder="What would you like to work on?"
                                    lineHeight={MULTI_TEXT_INPUT_LINE_HEIGHT}
                                    paddingTop={COMPOSER_INPUT_VERTICAL_PADDING}
                                    paddingBottom={COMPOSER_INPUT_VERTICAL_PADDING}
                                    maxHeight={240}
                                />
                            </View>
                            <View style={[
                                styles.sendButton,
                                hasText ? styles.sendButtonActive : styles.sendButtonInactive,
                            ]}>
                                <Pressable
                                    style={(p) => ({
                                        width: '100%',
                                        height: '100%',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        opacity: p.pressed ? 0.7 : 1,
                                    })}
                                    disabled={!hasText}
                                    onPress={() => {}}
                                >
                                    <Octicons
                                        name="arrow-up"
                                        size={16}
                                        color={theme.colors.button.primary.tint}
                                        style={{ marginTop: Platform.OS === 'web' ? 2 : 0 }}
                                    />
                                </Pressable>
                            </View>
                        </View>
                    </View>
                </View>

                <View style={{ height: Math.max(16, safeArea.bottom) }} />
            </View>

            {/* Native: picker bottom sheet */}
            {Platform.OS !== 'web' && (
                <BottomSheet
                    visible={!!activePicker}
                    onClose={() => setActivePicker(null)}
                >
                    {pickerData && <PickerContent {...pickerData} onSelect={handlePickerSelect} />}
                </BottomSheet>
            )}
        </KeyboardAvoidingView>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.header.background,
    },
    inner: {
        flex: 1,
    },
    configBox: {
        backgroundColor: theme.colors.input.background,
        borderRadius: Platform.select({ default: 16, android: 20 }),
        paddingVertical: 4,
        paddingHorizontal: 4,
        overflow: 'hidden',
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
    configRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 12,
    },
    collapsedRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 12,
    },
    configRowPressed: {
        opacity: 0.6,
    },
    configLabel: {
        fontSize: 14,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
        ...Platform.select({ web: { userSelect: 'none' } as any, default: {} }),
    },
    inputBox: {
        backgroundColor: theme.colors.input.background,
        borderRadius: Platform.select({ default: 16, android: 20 }),
        overflow: 'hidden',
        paddingVertical: 2,
        paddingHorizontal: 8,
    },
    inputField: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        paddingLeft: 8,
        paddingRight: 4,
        paddingVertical: 4,
        minHeight: 40,
        gap: 8,
    },
    sendButton: {
        width: COMPOSER_SEND_BUTTON_SIZE,
        height: COMPOSER_SEND_BUTTON_SIZE,
        borderRadius: COMPOSER_SEND_BUTTON_SIZE / 2,
        justifyContent: 'center',
        alignItems: 'center',
        flexShrink: 0,
        marginBottom: COMPOSER_SEND_BUTTON_MARGIN_BOTTOM,
    },
    sendButtonActive: {
        backgroundColor: theme.colors.button.primary.background,
    },
    sendButtonInactive: {
        backgroundColor: theme.colors.button.primary.disabled,
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
    title: {
        fontSize: 18,
        paddingVertical: 12,
        paddingHorizontal: 4,
        ...Typography.default('semiBold'),
        ...Platform.select({ web: { userSelect: 'none' } as any, default: {} }),
    } as const,
    searchRow: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 12,
        marginBottom: 8,
    },
    searchInput: {
        flex: 1,
        fontSize: 15,
        padding: 0,
        ...Typography.default(),
        ...Platform.select({ web: { outlineStyle: 'none' } as any, default: {} }),
    } as const,
    option: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: 12,
        paddingHorizontal: 12,
        paddingVertical: 12,
        borderRadius: 12,
    },
    optionPressed: {
        opacity: 0.6,
    } as const,
    optionText: {
        fontSize: 15,
        ...Typography.default(),
        ...Platform.select({ web: { userSelect: 'none' } as any, default: {} }),
    } as const,
    divider: {
        height: 1,
        marginHorizontal: 12,
        marginVertical: 4,
    } as const,
    emptyText: {
        fontSize: 14,
        textAlign: 'center' as const,
        paddingVertical: 20,
        ...Typography.default(),
        ...Platform.select({ web: { userSelect: 'none' } as any, default: {} }),
    } as const,
};

export default React.memo(SessionComposerDemo);
