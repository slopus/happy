import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { View, TextInput, Platform } from 'react-native';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';

import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Switch } from '@/components/Switch';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useSettingMutable } from '@/sync/storage';

type MessageSendMode = 'agent_queue' | 'interrupt' | 'server_pending';

export default React.memo(function SessionSettingsScreen() {
    const { theme } = useUnistyles();

    const [useTmux, setUseTmux] = useSettingMutable('sessionUseTmux');
    const [tmuxSessionName, setTmuxSessionName] = useSettingMutable('sessionTmuxSessionName');
    const [tmuxIsolated, setTmuxIsolated] = useSettingMutable('sessionTmuxIsolated');
    const [tmuxTmpDir, setTmuxTmpDir] = useSettingMutable('sessionTmuxTmpDir');

    const [messageSendMode, setMessageSendMode] = useSettingMutable('sessionMessageSendMode');

    const options: Array<{ key: MessageSendMode; title: string; subtitle: string }> = [
        {
            key: 'agent_queue',
            title: 'Queue in agent (current)',
            subtitle: 'Write to transcript immediately; agent processes when ready.',
        },
        {
            key: 'interrupt',
            title: 'Interrupt & send',
            subtitle: 'Abort current turn, then send immediately.',
        },
        {
            key: 'server_pending',
            title: 'Pending until ready',
            subtitle: 'Keep messages in a pending queue; agent pulls when ready.',
        },
    ];

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup title="Message sending" footer="Controls what happens when you send a message while the agent is running.">
                {options.map((option) => (
                    <Item
                        key={option.key}
                        title={option.title}
                        subtitle={option.subtitle}
                        icon={<Ionicons name="send-outline" size={29} color="#007AFF" />}
                        rightElement={messageSendMode === option.key ? <Ionicons name="checkmark" size={20} color="#007AFF" /> : null}
                        onPress={() => setMessageSendMode(option.key)}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>

            <ItemGroup title={t('profiles.tmux.title')}>
                <Item
                    title={t('profiles.tmux.spawnSessionsTitle')}
                    subtitle={useTmux ? t('profiles.tmux.spawnSessionsEnabledSubtitle') : t('profiles.tmux.spawnSessionsDisabledSubtitle')}
                    icon={<Ionicons name="terminal-outline" size={29} color="#5856D6" />}
                    rightElement={<Switch value={useTmux} onValueChange={setUseTmux} />}
                    showChevron={false}
                    onPress={() => setUseTmux(!useTmux)}
                />

                {useTmux && (
                    <>
                        <View style={[styles.inputContainer, { paddingTop: 0 }]}>
                            <Text style={styles.fieldLabel}>
                                {t('profiles.tmuxSession')} ({t('common.optional')})
                            </Text>
                            <TextInput
                                style={styles.textInput}
                                placeholder={t('profiles.tmux.sessionNamePlaceholder')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                value={tmuxSessionName ?? ''}
                                onChangeText={setTmuxSessionName}
                            />
                        </View>

                        <Item
                            title={t('profiles.tmux.isolatedServerTitle')}
                            subtitle={tmuxIsolated ? t('profiles.tmux.isolatedServerEnabledSubtitle') : t('profiles.tmux.isolatedServerDisabledSubtitle')}
                            icon={<Ionicons name="albums-outline" size={29} color="#5856D6" />}
                            rightElement={<Switch value={tmuxIsolated} onValueChange={setTmuxIsolated} />}
                            showChevron={false}
                            onPress={() => setTmuxIsolated(!tmuxIsolated)}
                        />

                        {tmuxIsolated && (
                            <View style={[styles.inputContainer, { paddingTop: 0, paddingBottom: 16 }]}>
                                <Text style={styles.fieldLabel}>
                                    {t('profiles.tmuxTempDir')} ({t('common.optional')})
                                </Text>
                                <TextInput
                                    style={styles.textInput}
                                    placeholder={t('profiles.tmux.tempDirPlaceholder')}
                                    placeholderTextColor={theme.colors.input.placeholder}
                                    value={tmuxTmpDir ?? ''}
                                    onChangeText={(value) => setTmuxTmpDir(value.trim().length > 0 ? value : null)}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                />
                            </View>
                        )}
                    </>
                )}
            </ItemGroup>
        </ItemList>
    );
});

const styles = StyleSheet.create((theme) => ({
    inputContainer: {
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    fieldLabel: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.groupped.sectionTitle,
        marginBottom: 4,
    },
    textInput: {
        ...Typography.default('regular'),
        backgroundColor: theme.colors.input.background,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: Platform.select({ ios: 10, default: 12 }),
        fontSize: Platform.select({ ios: 17, default: 16 }),
        lineHeight: Platform.select({ ios: 22, default: 24 }),
        letterSpacing: Platform.select({ ios: -0.41, default: 0.15 }),
        color: theme.colors.input.text,
        ...(Platform.select({
            web: {
                outline: 'none',
                outlineStyle: 'none',
                outlineWidth: 0,
                outlineColor: 'transparent',
                boxShadow: 'none',
                WebkitBoxShadow: 'none',
                WebkitAppearance: 'none',
            },
            default: {},
        }) as object),
    },
}));

