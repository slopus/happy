import * as React from 'react';
import { Linking, Platform, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { getAgentCore, type AgentId } from '@/agents/catalog';

export type CliNotDetectedBannerDismissScope = 'machine' | 'global' | 'temporary';

export function CliNotDetectedBanner(props: {
    agentId: AgentId;
    theme: any;
    onDismiss: (scope: CliNotDetectedBannerDismissScope) => void;
}) {
    const core = getAgentCore(props.agentId);
    const cliLabel = t(core.displayNameKey);
    const guideUrl = core.cli.installBanner.guideUrl;

    return (
        <View style={{
            backgroundColor: props.theme.colors.box.warning.background,
            borderRadius: 10,
            padding: 12,
            marginBottom: 12,
            borderWidth: 1,
            borderColor: props.theme.colors.box.warning.border,
        }}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 6 }}>
                <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginRight: 16 }}>
                    <Ionicons name="warning" size={16} color={props.theme.colors.warning} />
                    <Text style={{ fontSize: 13, fontWeight: '600', color: props.theme.colors.text, ...Typography.default('semiBold') }}>
                        {t('newSession.cliBanners.cliNotDetectedTitle', { cli: cliLabel })}
                    </Text>
                    <View style={{ flex: 1, minWidth: 20 }} />
                    <Text style={{ fontSize: 10, color: props.theme.colors.textSecondary, ...Typography.default() }}>
                        {t('newSession.cliBanners.dontShowFor')}
                    </Text>
                    <Pressable
                        onPress={() => props.onDismiss('machine')}
                        style={{
                            borderRadius: 4,
                            borderWidth: 1,
                            borderColor: props.theme.colors.textSecondary,
                            paddingHorizontal: 8,
                            paddingVertical: 3,
                        }}
                    >
                        <Text style={{ fontSize: 10, color: props.theme.colors.textSecondary, ...Typography.default() }}>
                            {t('newSession.cliBanners.thisMachine')}
                        </Text>
                    </Pressable>
                    <Pressable
                        onPress={() => props.onDismiss('global')}
                        style={{
                            borderRadius: 4,
                            borderWidth: 1,
                            borderColor: props.theme.colors.textSecondary,
                            paddingHorizontal: 8,
                            paddingVertical: 3,
                        }}
                    >
                        <Text style={{ fontSize: 10, color: props.theme.colors.textSecondary, ...Typography.default() }}>
                            {t('newSession.cliBanners.anyMachine')}
                        </Text>
                    </Pressable>
                </View>
                <Pressable
                    onPress={() => props.onDismiss('temporary')}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                    <Ionicons name="close" size={18} color={props.theme.colors.textSecondary} />
                </Pressable>
            </View>

            <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                {core.cli.installBanner.installKind === 'command' ? (
                    <Text style={{ fontSize: 11, color: props.theme.colors.textSecondary, ...Typography.default() }}>
                        {t('newSession.cliBanners.installCommand', { command: core.cli.installBanner.installCommand ?? '' })}
                    </Text>
                ) : (
                    <Text style={{ fontSize: 11, color: props.theme.colors.textSecondary, ...Typography.default() }}>
                        {t('newSession.cliBanners.installCliIfAvailable', { cli: cliLabel })}
                    </Text>
                )}

                {guideUrl ? (
                    <Pressable onPress={() => {
                        if (Platform.OS === 'web') {
                            window.open(guideUrl, '_blank');
                        } else {
                            void Linking.openURL(guideUrl).catch(() => {});
                        }
                    }}>
                        <Text style={{ fontSize: 11, color: props.theme.colors.textLink, ...Typography.default() }}>
                            {t('newSession.cliBanners.viewInstallationGuide')}
                        </Text>
                    </Pressable>
                ) : null}
            </View>
        </View>
    );
}
