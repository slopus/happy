import * as React from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import { AgentInput } from '@/components/AgentInput';
import { Avatar } from '@/components/Avatar';
import { ProviderIcon } from '@/components/ProviderIcon';
import { RigActivityBar } from '@/components/RigActivityBar';
import { StatusDot } from '@/components/StatusDot';
import { Typography } from '@/constants/Typography';
import {
    getAvailableModels,
    getAvailablePermissionModes,
    getEffortLevelsForModel,
    type EffortLevel,
    type ModelMode,
    type PermissionMode,
} from '@/components/modelModeOptions';
import { rigMetadataFixture } from '@/sync/__testdata__/rigMetadata';
import { t } from '@/text';

export default function RigPreviewScreen() {
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const models = React.useMemo(() => getAvailableModels('codex', rigMetadataFixture, t), []);
    const modes = React.useMemo(() => getAvailablePermissionModes('codex', rigMetadataFixture, t), []);
    const [model, setModel] = React.useState<ModelMode>(models[0]);
    const [mode, setMode] = React.useState<PermissionMode>(modes[0]);
    const efforts = React.useMemo(
        () => getEffortLevelsForModel('codex', model.key, rigMetadataFixture),
        [model.key],
    );
    const [effort, setEffort] = React.useState<EffortLevel>(efforts.find((item) => item.key === 'high') ?? efforts[0]);

    const handleModelChange = React.useCallback((next: ModelMode) => {
        setModel(next);
        const nextEfforts = getEffortLevelsForModel('codex', next.key, rigMetadataFixture);
        setEffort(nextEfforts.find((item) => item.key === next.defaultThinkingLevel) ?? nextEfforts[0]);
    }, []);

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.groupped.background }}>
            <ScrollView
                contentContainerStyle={{
                    width: '100%',
                    maxWidth: 760,
                    alignSelf: 'center',
                    paddingHorizontal: 20,
                    paddingTop: 28,
                    paddingBottom: safeArea.bottom + 180,
                    gap: 20,
                }}
            >
                <View>
                    <Text style={{ fontSize: 12, color: theme.colors.textSecondary, textTransform: 'uppercase', letterSpacing: 1.2, ...Typography.mono() }}>
                        Live metadata preview
                    </Text>
                    <Text style={{ marginTop: 5, fontSize: 28, color: theme.colors.text, ...Typography.default('semiBold') }}>
                        Rig in Happy
                    </Text>
                </View>

                <View style={{
                    minHeight: 104,
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingHorizontal: 18,
                    paddingVertical: 16,
                    borderRadius: 16,
                    backgroundColor: theme.colors.surface,
                    borderWidth: Platform.OS === 'web' ? 1 : 0,
                    borderColor: theme.colors.divider,
                }}>
                    <Avatar id="rig-preview:/tmp/rig-project" size={56} flavor="codex" clientId="rig" />
                    <View style={{ marginLeft: 16, flex: 1, gap: 4 }}>
                        <Text style={{ fontSize: 17, color: theme.colors.text, ...Typography.default('semiBold') }}>
                            Rig integration
                        </Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                            <ProviderIcon kind="codex" size={14} />
                            <Text style={{ fontSize: 13, color: theme.colors.textSecondary, ...Typography.default() }}>
                                Rig · OpenAI Codex
                            </Text>
                        </View>
                        <Text style={{ fontSize: 13, color: theme.colors.text, ...Typography.default('semiBold') }}>
                            {model.name}
                        </Text>
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                        <StatusDot color="#34C759" />
                        <Text style={{ fontSize: 12, color: '#34C759', ...Typography.default('semiBold') }}>online</Text>
                    </View>
                </View>

                <View style={{ borderRadius: 14, backgroundColor: theme.colors.surface, borderWidth: Platform.OS === 'web' ? 1 : 0, borderColor: theme.colors.divider }}>
                    <View style={{ paddingHorizontal: 16, paddingTop: 14 }}>
                        <Text style={{ fontSize: 13, color: theme.colors.text, ...Typography.default('semiBold') }}>Rig activity</Text>
                    </View>
                    <RigActivityBar metadata={rigMetadataFixture} />
                    <View style={{ height: 10 }} />
                </View>

                <View style={{ gap: 8 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                        <Text style={{ fontSize: 13, color: theme.colors.textSecondary, ...Typography.default('semiBold') }}>
                            Message configuration
                        </Text>
                        <Pressable style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                            <Ionicons name="lock-closed-outline" size={12} color={theme.colors.textSecondary} />
                            <Text style={{ fontSize: 11, color: theme.colors.textSecondary, ...Typography.default() }}>encrypted v3</Text>
                        </Pressable>
                    </View>
                    <AgentInput
                        initialValue=""
                        placeholder="Send a message to Rig"
                        onSend={() => {}}
                        permissionMode={mode}
                        availableModes={modes}
                        onPermissionModeChange={setMode}
                        modelMode={model}
                        availableModels={models}
                        onModelModeChange={handleModelChange}
                        effortLevel={effort}
                        availableEffortLevels={efforts}
                        onEffortLevelChange={setEffort}
                        metadata={rigMetadataFixture}
                        connectionStatus={{ text: 'online', color: '#34C759', dotColor: '#34C759' }}
                        autocompletePrefixes={[]}
                        autocompleteSuggestions={async () => []}
                        showAbortButton
                        onAbort={() => {}}
                    />
                </View>
            </ScrollView>
        </View>
    );
}
