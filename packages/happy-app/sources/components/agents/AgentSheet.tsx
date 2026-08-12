import * as React from 'react';
import { Text, View, Pressable, Modal, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSetting, useAllMachines } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { useNewSessionDraft } from '@/hooks/useNewSessionDraft';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { launchAgent, type AgentLauncher } from './launchAgent';
import { createAppBuilderAgent, createRelationshipAdvisorAgent, getAgentSubtitle } from './builtinAgents';
import { useEnterAgentSpace } from '@/hooks/useEnterAgentSpace';
import { useAgentSpace } from '@/hooks/useAgentSpace';

/**
 * 底部抽屉，列出用户配置的「我的 Agent」。
 * 点击在线 Agent → 预填新建会话 draft 并导航；离线 / 机器缺失的 Agent 置灰不可点。
 * 复用 RN 原生 Modal（transparent + slide）+ 半透明 scrim，沿用侧栏卡片视觉语言。
 */
export const AgentSheet = React.memo(({ visible, onClose }: { visible: boolean; onClose: () => void }) => {
    const styles = stylesheet;
    const safeArea = useSafeAreaInsets();
    const router = useRouter();
    const agents = useLocalSetting('agents');
    const machines = useAllMachines({ includeOffline: true });
    const draft = useNewSessionDraft();
    const { entering, enter } = useEnterAgentSpace();
    const { enter: enterSpace } = useAgentSpace();
    const relationshipAdvisorTitle = t('relationshipAdvisor.title');
    const relationshipAdvisorSubtitle = t('relationshipAdvisor.cloudSubtitle');
    const builtinRelationshipAdvisor = React.useMemo(() => createRelationshipAdvisorAgent({
        title: relationshipAdvisorTitle,
        subtitle: relationshipAdvisorSubtitle,
    }), [relationshipAdvisorSubtitle, relationshipAdvisorTitle]);
    const builtinAppAgent = React.useMemo(() => createAppBuilderAgent({
        machines,
        preferredMachineId: draft.selectedMachineId,
        preferredPath: draft.selectedPath,
        title: t('agents.appBuilderTitle'),
        presetBuildLabel: t('agents.appBuilderPresetBuild'),
        presetBugfixLabel: t('agents.appBuilderPresetBugfix'),
    }), [draft.selectedMachineId, draft.selectedPath, machines]);
    const visibleAgents = React.useMemo(
        () => [builtinRelationshipAdvisor, ...(builtinAppAgent ? [builtinAppAgent] : []), ...agents],
        [builtinAppAgent, builtinRelationshipAdvisor, agents],
    );

    const goManage = React.useCallback(() => {
        if (entering) return;
        onClose();
        router.navigate('/settings/my-agents');
    }, [entering, onClose, router]);

    const onPickAgent = React.useCallback(async (agent: AgentLauncher) => {
        if (entering) return;
        // 持久化的「我的 Agent」→ 进入其专属空间（侧栏收敛为工作台）。内置 App Builder Agent
        // 的 id 是每次动态生成的、不适合作为持久空间锚点，保持原「直接发起新会话」行为。
        if (agents.some((a) => a.id === agent.id)) {
            if (agent.kind === 'image-styles') {
                onClose();
                enterSpace(agent.id);
            } else {
                await enter(agent, { beforeNavigate: onClose });
            }
        } else {
            onClose();
            launchAgent(agent, draft, (p) => router.navigate(p as any));
        }
    }, [agents, draft, enter, entering, enterSpace, onClose, router]);

    const closeIfIdle = React.useCallback(() => {
        if (!entering) onClose();
    }, [entering, onClose]);

    return (
        <Modal visible={visible} transparent animationType="slide" onRequestClose={closeIfIdle}>
            <Pressable style={styles.scrim} disabled={entering} onPress={closeIfIdle} />
            <View style={[styles.sheet, { paddingBottom: safeArea.bottom + 12 }]}>
                {/* Grab handle */}
                <View style={styles.handle} />

                {/* Header */}
                <View style={styles.header}>
                    <Text style={styles.title} numberOfLines={1}>{t('agents.cardTitle')}</Text>
                    <Pressable
                        onPress={goManage}
                        disabled={entering}
                        style={({ pressed }) => [styles.manageBtn, pressed && styles.pressed]}
                        hitSlop={8}
                    >
                        <Text style={styles.manageText}>{t('agents.manage')}</Text>
                    </Pressable>
                </View>

                {visibleAgents.length === 0 ? (
                    <Pressable
                        onPress={goManage}
                        disabled={entering}
                        style={({ pressed }) => [styles.empty, pressed && styles.pressed]}
                    >
                        <Text style={styles.emptyText}>{t('agents.empty')}</Text>
                    </Pressable>
                ) : (
                    <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
                        {visibleAgents.map((agent) => {
                            const machine = machines.find((m) => m.id === agent.machineId);
                            const isCloudAdvisor = agent.runtime === 'relationship-advisor';
                            const online = isCloudAdvisor || (!!machine && isMachineOnline(machine));
                            const missing = !isCloudAdvisor && !machine;
                            const subtitle = isCloudAdvisor
                                ? agent.path
                                : getAgentSubtitle(agent, machine, missing ? t('agents.machineMissing') : agent.machineId);

                            return (
                                <Pressable
                                    key={agent.id}
                                    testID={isCloudAdvisor
                                        ? 'agent-sheet-relationship-advisor'
                                        : `agent-sheet-agent-${agent.id}`}
                                    disabled={!online || entering}
                                    onPress={() => onPickAgent(agent)}
                                    style={({ pressed }) => [
                                        styles.row,
                                        !online && styles.rowDisabled,
                                        online && pressed && styles.pressed,
                                    ]}
                                >
                                    {/* Avatar with status dot */}
                                    <View style={styles.avatarWrap}>
                                        <View style={[styles.avatar, { backgroundColor: agent.color }]}>
                                            <Text style={styles.avatarGlyph}>{agent.glyph}</Text>
                                        </View>
                                        <View
                                            style={[
                                                styles.dot,
                                                { backgroundColor: online ? styles.dotOnline.color : styles.dotOffline.color },
                                            ]}
                                        />
                                    </View>

                                    {/* Text block */}
                                    <View style={styles.rowText}>
                                        <Text style={styles.name} numberOfLines={1}>{agent.name}</Text>
                                        <Text style={styles.subtitle} numberOfLines={1}>
                                            {agent.kind === 'image-styles' ? `${t('agents.imageStyleAgent')} · ${subtitle}` : subtitle}
                                        </Text>
                                        {entering && online ? (
                                            <Text style={styles.statusLabel} numberOfLines={1}>
                                                {t('agentSpace.entering')}
                                            </Text>
                                        ) : !online && (
                                            <Text style={styles.statusLabel} numberOfLines={1}>
                                                {missing ? t('agents.machineMissing') : t('agents.machineOffline')}
                                            </Text>
                                        )}
                                    </View>

                                    {online && (
                                        <Ionicons name="chevron-forward" size={18} color={styles.chevron.color} />
                                    )}
                                </Pressable>
                            );
                        })}
                    </ScrollView>
                )}
            </View>
        </Modal>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    scrim: {
        flex: 1,
        backgroundColor: 'rgba(0, 0, 0, 0.4)',
    },
    sheet: {
        backgroundColor: theme.colors.groupped.background,
        borderTopLeftRadius: 16,
        borderTopRightRadius: 16,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        paddingTop: 8,
        paddingHorizontal: 16,
        maxHeight: '80%',
    },
    handle: {
        alignSelf: 'center',
        width: 36,
        height: 4,
        borderRadius: 2,
        backgroundColor: theme.colors.divider,
        marginBottom: 12,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 8,
    },
    title: {
        flex: 1,
        fontSize: 17,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    manageBtn: {
        paddingVertical: 4,
        paddingHorizontal: 8,
        borderRadius: 8,
    },
    manageText: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    pressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    list: {
        flexGrow: 0,
    },
    listContent: {
        paddingVertical: 4,
        gap: 8,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: 14,
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        gap: 12,
    },
    rowDisabled: {
        opacity: 0.5,
    },
    avatarWrap: {
        width: 40,
        height: 40,
    },
    avatar: {
        width: 40,
        height: 40,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
    },
    avatarGlyph: {
        color: '#FFFFFF',
        fontSize: 18,
        ...Typography.default('semiBold'),
    },
    dot: {
        position: 'absolute',
        right: -2,
        bottom: -2,
        width: 12,
        height: 12,
        borderRadius: 6,
        borderWidth: 2,
        borderColor: theme.colors.surface,
    },
    dotOnline: {
        color: theme.colors.status.connected,
    },
    dotOffline: {
        color: theme.colors.status.disconnected,
    },
    rowText: {
        flex: 1,
    },
    name: {
        fontSize: 15,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    subtitle: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        marginTop: 2,
        ...Typography.default(),
    },
    path: {
        color: theme.colors.textSecondary,
        ...Typography.mono(),
    },
    statusLabel: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginTop: 2,
        ...Typography.default(),
    },
    chevron: {
        color: theme.colors.textSecondary,
    },
    empty: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 32,
    },
    emptyText: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        ...Typography.default(),
    },
}));
