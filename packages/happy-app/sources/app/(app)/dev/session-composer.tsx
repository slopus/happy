import React from 'react';
import { View, Text, Platform, Pressable } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';
import { MultiTextInput } from '@/components/MultiTextInput';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import Constants from 'expo-constants';
import { useHeaderHeight } from '@/utils/responsive';

// Agent icon assets (same as Avatar.tsx)
const agentIcons = {
    claude: require('@/assets/images/icon-claude.png'),
    codex: require('@/assets/images/icon-gpt.png'),
    openclaw: require('@/assets/images/icon-openclaw.png'),
};

// Hardcoded sample data
const SAMPLE_MACHINE_NAME = "Kirill's MacBook Pro";
const SAMPLE_PATH = '~/projects/happy/happy';

type AgentKey = 'claude' | 'codex' | 'openclaw';
const AGENTS: { key: AgentKey; label: string }[] = [
    { key: 'claude', label: 'Claude Code' },
    { key: 'codex', label: 'Codex' },
    { key: 'openclaw', label: 'OpenClaw' },
];

const PERMISSION_MODES = ['Default', 'Accept Edits', 'Plan', 'YOLO'] as const;
const MODELS = ['Opus', 'Sonnet', 'Haiku'] as const;

// Effort: 4 levels shown as filled/empty bolt icons
const EFFORT_LEVELS = 4;

// Render a stable-width chip that shows/hides options to avoid layout jumps.
// All options are rendered but only the active one is visible.
function StableChip<T extends string>({
    options,
    activeIndex,
    onPress,
    icon,
}: {
    options: readonly T[];
    activeIndex: number;
    onPress: () => void;
    icon: React.ReactNode;
}) {
    const { theme } = useUnistyles();
    return (
        <Pressable onPress={onPress} style={(p) => [styles.chip, p.pressed && styles.chipPressed]}>
            {icon}
            <View>
                {options.map((opt, i) => (
                    <Text
                        key={opt}
                        style={[
                            styles.chipText,
                            { color: theme.colors.textSecondary },
                            i !== activeIndex && styles.hiddenOption,
                        ]}
                    >
                        {opt}
                    </Text>
                ))}
            </View>
        </Pressable>
    );
}

// Effort bolts: filled up to level, empty after
function EffortBolts({ level, max, onPress }: { level: number; max: number; onPress: () => void }) {
    const { theme } = useUnistyles();
    return (
        <Pressable onPress={onPress} style={(p) => [styles.chip, p.pressed && styles.chipPressed]}>
            {Array.from({ length: max }, (_, i) => (
                <Ionicons
                    key={i}
                    name={i < level ? 'flash' : 'flash-outline'}
                    size={12}
                    color={i < level ? theme.colors.text : theme.colors.textSecondary}
                />
            ))}
        </Pressable>
    );
}

function SessionComposerDemo() {
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();

    const [prompt, setPrompt] = React.useState('');
    const [selectedAgent, setSelectedAgent] = React.useState<AgentKey>('claude');
    const [permissionIndex, setPermissionIndex] = React.useState(0);
    const [modelIndex, setModelIndex] = React.useState(0);
    const [effortLevel, setEffortLevel] = React.useState(3); // 1-4, default High (3)
    const [worktree, setWorktree] = React.useState(false);

    const hasText = prompt.trim().length > 0;

    const cyclePermission = React.useCallback(() => {
        setPermissionIndex(i => (i + 1) % PERMISSION_MODES.length);
    }, []);
    const cycleModel = React.useCallback(() => {
        setModelIndex(i => (i + 1) % MODELS.length);
    }, []);
    const cycleEffort = React.useCallback(() => {
        setEffortLevel(l => (l % EFFORT_LEVELS) + 1);
    }, []);
    const cycleAgent = React.useCallback(() => {
        setSelectedAgent(prev => {
            const idx = AGENTS.findIndex(a => a.key === prev);
            return AGENTS[(idx + 1) % AGENTS.length].key;
        });
    }, []);

    const agent = AGENTS.find(a => a.key === selectedAgent)!;

    return (
        <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            keyboardVerticalOffset={Platform.OS === 'ios' ? Constants.statusBarHeight + useHeaderHeight() : 0}
            style={styles.container}
        >
            <View style={styles.inner}>
                <View style={{ maxWidth: layout.maxWidth, width: '100%', alignSelf: 'center', paddingHorizontal: 12, gap: 8, paddingTop: 12 }}>

                    {/* Config box */}
                    <View style={styles.configBox}>
                        {/* Machine row */}
                        <Pressable
                            style={(p) => [styles.configRow, p.pressed && styles.configRowPressed]}
                            onPress={() => {}}
                        >
                            <Ionicons name="desktop-outline" size={15} color={theme.colors.textSecondary} />
                            <Text style={styles.configLabel} numberOfLines={1}>
                                {SAMPLE_MACHINE_NAME}
                            </Text>
                        </Pressable>

                        {/* Path row */}
                        <Pressable
                            style={(p) => [styles.configRow, p.pressed && styles.configRowPressed]}
                            onPress={() => {}}
                        >
                            <Ionicons name="folder-outline" size={15} color={theme.colors.textSecondary} />
                            <Text style={styles.configLabel} numberOfLines={1}>
                                {SAMPLE_PATH}
                            </Text>
                        </Pressable>

                        {/* Agent row */}
                        <Pressable
                            style={(p) => [styles.configRow, p.pressed && styles.configRowPressed]}
                            onPress={cycleAgent}
                        >
                            <Image
                                source={agentIcons[agent.key]}
                                style={{ width: 15, height: 15 }}
                                contentFit="contain"
                            />
                            {/* Stable width: render all labels, hide inactive */}
                            <View>
                                {AGENTS.map(a => (
                                    <Text
                                        key={a.key}
                                        style={[
                                            styles.configLabel,
                                            a.key !== selectedAgent && styles.hiddenOption,
                                        ]}
                                        numberOfLines={1}
                                    >
                                        {a.label}
                                    </Text>
                                ))}
                            </View>
                        </Pressable>
                    </View>
                </View>

                {/* Spacer pushes input to bottom */}
                <View style={{ flex: 1 }} />

                <View style={{ maxWidth: layout.maxWidth, width: '100%', alignSelf: 'center', paddingHorizontal: 12, gap: 8 }}>
                    {/* Input box */}
                    <View style={styles.inputBox}>
                        {/* Text input */}
                        <View style={styles.inputField}>
                            <MultiTextInput
                                value={prompt}
                                onChangeText={setPrompt}
                                placeholder="What would you like to work on?"
                                paddingTop={Platform.OS === 'web' ? 10 : 8}
                                paddingBottom={Platform.OS === 'web' ? 10 : 8}
                                maxHeight={120}
                            />
                        </View>

                        {/* Bottom row: chips + send */}
                        <View style={styles.bottomRow}>
                            <View style={styles.chipsRow}>
                                {/* Permission mode */}
                                <StableChip
                                    options={PERMISSION_MODES}
                                    activeIndex={permissionIndex}
                                    onPress={cyclePermission}
                                    icon={<Ionicons name="shield-outline" size={12} color={theme.colors.textSecondary} />}
                                />

                                <Text style={styles.chipDot}>·</Text>

                                {/* Model */}
                                <StableChip
                                    options={MODELS}
                                    activeIndex={modelIndex}
                                    onPress={cycleModel}
                                    icon={<Octicons name="diamond" size={10} color={theme.colors.textSecondary} />}
                                />

                                <Text style={styles.chipDot}>·</Text>

                                {/* Effort bolts */}
                                <EffortBolts level={effortLevel} max={EFFORT_LEVELS} onPress={cycleEffort} />

                                <Text style={styles.chipDot}>·</Text>

                                {/* Worktree checkbox */}
                                <Pressable
                                    onPress={() => setWorktree(w => !w)}
                                    style={(p) => [styles.chip, p.pressed && styles.chipPressed]}
                                >
                                    <Ionicons
                                        name={worktree ? 'checkbox' : 'square-outline'}
                                        size={13}
                                        color={worktree ? theme.colors.button.primary.background : theme.colors.textSecondary}
                                    />
                                    <Text style={[styles.chipText, worktree && { color: theme.colors.text }]}>
                                        Worktree
                                    </Text>
                                </Pressable>
                            </View>

                            {/* Send button */}
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
        </KeyboardAvoidingView>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    inner: {
        flex: 1,
    },
    configBox: {
        backgroundColor: theme.colors.input.background,
        borderRadius: Platform.select({ default: 16, android: 20 }),
        paddingVertical: 4,
        paddingHorizontal: 4,
    },
    configRow: {
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
    },
    hiddenOption: {
        height: 0,
        overflow: 'hidden',
        opacity: 0,
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
    bottomRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 4,
    },
    chipsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        flex: 1,
        gap: 2,
    },
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 6,
        paddingVertical: 4,
        borderRadius: 8,
    },
    chipPressed: {
        opacity: 0.6,
    },
    chipText: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    chipDot: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    sendButton: {
        width: 32,
        height: 32,
        borderRadius: 16,
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
}));

export default React.memo(SessionComposerDemo);
