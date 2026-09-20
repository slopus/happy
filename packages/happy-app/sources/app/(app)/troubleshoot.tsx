import * as React from 'react';
import { Linking, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { Stack, useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { RoundButton } from '@/components/RoundButton';
import { TerminalBlock } from '@/components/onboarding/TerminalBlock';
import { useAllMachines, useSessions } from '@/sync/storage';
import { collectMachineChoices } from '@/sync/machineChoices';
import { buildOfflineMachineTroubleshooting } from '@/utils/offlineMachineTroubleshooting';
import { Modal } from '@/modal';
import { layout } from '@/components/layout';
import { t } from '@/text';

const DESKTOP_URL = 'https://happy.engineering';

/**
 * What to check when every linked computer is offline. The order is the
 * order of likelihood: the machine is asleep, then Happy is not open, then
 * the terminal daemon has stopped. The AI prompt at the end points a coding
 * agent on the computer at the local Happy logs.
 */
export default function TroubleshootScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const machines = useAllMachines({ includeOffline: true });
    const sessions = useSessions();
    const choices = React.useMemo(() => collectMachineChoices(machines), [machines]);
    const guide = React.useMemo(() => buildOfflineMachineTroubleshooting(choices, sessions), [choices, sessions]);
    const [copied, setCopied] = React.useState(false);

    const copyPrompt = React.useCallback(async () => {
        try {
            await Clipboard.setStringAsync(guide.aiPrompt);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            Modal.alert(t('common.error'), t('troubleshoot.copyFailed'));
        }
    }, [guide.aiPrompt]);

    const step = (icon: React.ComponentProps<typeof Ionicons>['name'], title: string, body: React.ReactNode) => (
        <View style={styles.step}>
            <View style={styles.stepIcon}>
                <Ionicons name={icon} size={22} color={theme.colors.textSecondary} />
            </View>
            <View style={styles.stepText}>
                <Text style={styles.stepTitle}>{title}</Text>
                {body}
            </View>
        </View>
    );

    return (
        <>
            <Stack.Screen
                options={{
                    headerShown: true,
                    headerTitle: t('troubleshoot.title'),
                    headerTitleAlign: 'center',
                    headerBackTitle: t('common.back'),
                }}
            />
            <ItemList>
                <View style={styles.content}>
                    <Text style={styles.heading}>{t('troubleshoot.heading')}</Text>
                    <Text style={styles.intro}>{t('troubleshoot.intro')}</Text>

                    {step('moon-outline', t('troubleshoot.awakeStep'), (
                        <Text style={styles.stepBody}>{t('troubleshoot.awakeBody')}</Text>
                    ))}
                    {step('desktop-outline', t('troubleshoot.desktopStep'), (
                        <Text style={styles.stepBody}>
                            {t('troubleshoot.desktopBodyPrefix')}
                            <Text
                                style={styles.link}
                                accessibilityRole="link"
                                onPress={() => { void Linking.openURL(DESKTOP_URL); }}
                            >
                                {t('troubleshoot.desktopBodyLink')}
                            </Text>
                            {t('troubleshoot.desktopBodySuffix')}
                        </Text>
                    ))}
                    {step('terminal-outline', t('troubleshoot.terminalStep'), (
                        <>
                            <Text style={styles.stepBody}>{t('troubleshoot.terminalBody')}</Text>
                            <TerminalBlock
                                style={styles.terminal}
                                lines={[
                                    { kind: 'comment', text: t('troubleshoot.terminalComment') },
                                    { kind: 'command', text: t('onboarding.terminalInstall') },
                                    { kind: 'command', text: t('onboarding.terminalRun') },
                                ]}
                            />
                        </>
                    ))}
                </View>

                {choices.length > 0 ? (
                    <ItemGroup title={t('troubleshoot.machines')}>
                        {choices.map((choice) => (
                            <Item
                                key={choice.id}
                                title={choice.name}
                                subtitle={choice.online ? undefined : t('troubleshoot.machineOffline')}
                                icon={<Ionicons name="desktop-outline" size={28} color={theme.colors.textSecondary} />}
                                showChevron={true}
                                onPress={() => router.push(`/machine/${choice.id}`)}
                            />
                        ))}
                    </ItemGroup>
                ) : null}

                <View style={styles.promptSection}>
                    <View style={styles.button}>
                        <RoundButton
                            size="normal"
                            display="inverted"
                            title={copied ? t('troubleshoot.copied') : t('troubleshoot.copyAiPrompt')}
                            onPress={() => { void copyPrompt(); }}
                        />
                    </View>
                    <Text style={styles.promptHint}>{t('troubleshoot.copyAiPromptHint')}</Text>
                </View>
            </ItemList>
        </>
    );
}

const styles = StyleSheet.create((theme) => ({
    content: {
        alignSelf: 'center',
        width: '100%',
        maxWidth: layout.maxWidth,
        paddingHorizontal: 24,
        paddingTop: 20,
    },
    heading: {
        ...Typography.default('semiBold'),
        fontSize: 24,
        lineHeight: 30,
        color: theme.colors.text,
        marginBottom: 8,
    },
    intro: {
        ...Typography.default(),
        fontSize: 15,
        lineHeight: 21,
        color: theme.colors.textSecondary,
        marginBottom: 24,
    },
    step: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
        marginBottom: 20,
    },
    stepIcon: {
        width: 26,
        height: 22,
        alignItems: 'center',
        justifyContent: 'center',
    },
    stepText: {
        flex: 1,
    },
    stepTitle: {
        ...Typography.default('semiBold'),
        fontSize: 17,
        lineHeight: 22,
        color: theme.colors.text,
        marginBottom: 4,
    },
    stepBody: {
        ...Typography.default(),
        fontSize: 15,
        lineHeight: 21,
        color: theme.colors.textSecondary,
    },
    link: {
        color: theme.colors.text,
        textDecorationLine: 'underline',
    },
    terminal: {
        marginTop: 12,
    },
    promptSection: {
        alignSelf: 'center',
        width: '100%',
        maxWidth: layout.maxWidth,
        alignItems: 'center',
        paddingHorizontal: 24,
        paddingTop: 20,
    },
    button: {
        width: 260,
        maxWidth: '100%',
    },
    promptHint: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        marginTop: 8,
    },
}));
