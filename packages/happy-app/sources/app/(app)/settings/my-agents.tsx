import * as React from 'react';
import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useLocalSetting, useAllMachines } from '@/sync/storage';
import { useNewSessionDraft } from '@/hooks/useNewSessionDraft';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useSettingsRouter } from '@/components/DesktopSettingsNavigation';
import { launchAgent, type AgentLauncher } from '@/components/agents/launchAgent';
import { createAppBuilderAgent, getAgentSubtitle } from '@/components/agents/builtinAgents';

/**
 * 「我的 Agent」配置列表页：展示已配置的 Agent，点击行进入编辑，顶部入口新建。
 * 每行左侧是色块 + 首字头像，副标题为「机器名 · 路径」。
 */
export default React.memo(function MyAgentsSettingsScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useSettingsRouter();
    const agents = useLocalSetting('agents');
    const machines = useAllMachines({ includeOffline: true });
    const draft = useNewSessionDraft();
    const builtinAppAgent = React.useMemo(() => createAppBuilderAgent({
        machines,
        preferredMachineId: draft.selectedMachineId,
        preferredPath: draft.selectedPath,
        title: t('agents.appBuilderTitle'),
        presetBuildLabel: t('agents.appBuilderPresetBuild'),
        presetBugfixLabel: t('agents.appBuilderPresetBugfix'),
    }), [draft.selectedMachineId, draft.selectedPath, machines]);

    const machineName = React.useCallback((machineId: string): string => {
        const machine = machines.find((m) => m.id === machineId);
        return machine?.metadata?.displayName ?? machine?.metadata?.host ?? (machine ? machineId : t('agents.machineMissing'));
    }, [machines]);
    const handleLaunchAgent = React.useCallback((agent: AgentLauncher) => {
        launchAgent(agent, draft, (p) => router.navigate(p as any));
    }, [draft, router]);

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {builtinAppAgent && (
                <ItemGroup title={t('agents.builtinTitle')}>
                    <Item
                        title={builtinAppAgent.name}
                        subtitle={getAgentSubtitle(
                            builtinAppAgent,
                            machines.find((m) => m.id === builtinAppAgent.machineId),
                            t('agents.machineMissing'),
                        )}
                        leftElement={
                            <View style={[styles.avatar, { backgroundColor: builtinAppAgent.color }]}>
                                <Text style={styles.avatarGlyph}>{builtinAppAgent.glyph}</Text>
                            </View>
                        }
                        onPress={() => handleLaunchAgent(builtinAppAgent)}
                    />
                </ItemGroup>
            )}

            <ItemGroup>
                <Item
                    title={t('agents.new')}
                    icon={<Ionicons name="add-circle-outline" size={29} color={theme.colors.accent} />}
                    onPress={() => router.push('/settings/my-agent-edit' as any)}
                />
            </ItemGroup>

            {agents.length === 0 ? (
                <View style={styles.empty}>
                    <Ionicons name="people-outline" size={48} color={theme.colors.textSecondary} />
                    <Text style={styles.emptyText}>{t('agents.empty')}</Text>
                </View>
            ) : (
                <ItemGroup title={t('agents.title')}>
                    {agents.map((agent) => (
                        <Item
                            key={agent.id}
                            title={agent.name}
                            subtitle={`${agent.kind === 'image-styles' ? `${t('agents.imageStyleAgent')} · ` : ''}${machineName(agent.machineId)} · ${agent.path}`}
                            leftElement={
                                <View style={[styles.avatar, { backgroundColor: agent.color }]}>
                                    <Text style={styles.avatarGlyph}>{agent.glyph}</Text>
                                </View>
                            }
                            onPress={() => router.push(`/settings/my-agent-edit?id=${agent.id}` as any)}
                        />
                    ))}
                </ItemGroup>
            )}
        </ItemList>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    avatar: {
        width: 29,
        height: 29,
        borderRadius: 7,
        alignItems: 'center',
        justifyContent: 'center',
    },
    avatarGlyph: {
        color: '#FFFFFF',
        fontSize: 15,
        ...Typography.default('semiBold'),
    },
    empty: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 48,
        paddingHorizontal: 32,
        gap: 12,
    },
    emptyText: {
        fontSize: 15,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        ...Typography.default(),
    },
}));
