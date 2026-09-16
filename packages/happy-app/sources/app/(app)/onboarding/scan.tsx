import * as React from 'react';
import { Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { RoundButton } from '@/components/RoundButton';
import { useConnectTerminal } from '@/hooks/useConnectTerminal';
import { useAllMachines } from '@/sync/storage';
import { Modal } from '@/modal';
import { trackConnectAttempt } from '@/track';
import { t } from '@/text';

// How long to hold this screen after a successful scan while the linked
// machine syncs in. Going home before it arrives would flash step 2 again.
const MACHINE_ARRIVAL_TIMEOUT_MS = 10_000;

/**
 * Step 3 of the first run: point the camera at the QR code the computer is
 * showing. Success returns to the home screen, which now has a machine.
 */
export default function OnboardingScanScreen() {
    const router = useRouter();
    const machines = useAllMachines({ includeOffline: true });
    const [approved, setApproved] = React.useState(false);
    const { connectTerminal, connectWithUrl, isLoading } = useConnectTerminal({
        onSuccess: () => setApproved(true),
    });

    React.useEffect(() => {
        if (!approved) return;
        if (machines.length > 0) {
            router.back();
            return;
        }
        const timer = setTimeout(() => router.back(), MACHINE_ARRIVAL_TIMEOUT_MS);
        return () => clearTimeout(timer);
    }, [approved, machines.length, router]);

    const scan = React.useCallback(() => {
        trackConnectAttempt();
        void connectTerminal();
    }, [connectTerminal]);

    const pasteLink = React.useCallback(async () => {
        const url = await Modal.prompt(
            t('onboarding.pasteLinkTitle'),
            t('onboarding.pasteLinkMessage'),
            {
                placeholder: 'happy://terminal?...',
                cancelText: t('common.cancel'),
                confirmText: t('common.continue'),
            },
        );
        if (url?.trim()) {
            trackConnectAttempt();
            void connectWithUrl(url.trim());
        }
    }, [connectWithUrl]);

    const busy = isLoading || approved;

    return (
        <View style={styles.content}>
            <Text style={styles.title}>{t('onboarding.scanTitle')}</Text>
            <Text style={styles.body}>{t('onboarding.scanBody')}</Text>
            <View style={styles.buttonContainer}>
                <RoundButton
                    title={approved ? t('onboarding.connecting') : t('onboarding.scanButton')}
                    loading={busy}
                    onPress={scan}
                />
            </View>
            <View style={styles.buttonContainer}>
                <RoundButton
                    size="normal"
                    display="inverted"
                    title={t('onboarding.pasteLink')}
                    disabled={busy}
                    onPress={() => { void pasteLink(); }}
                />
            </View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    content: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 32,
        paddingBottom: 48,
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 24,
        lineHeight: 30,
        color: theme.colors.text,
        textAlign: 'center',
        marginBottom: 12,
    },
    body: {
        ...Typography.default(),
        fontSize: 17,
        lineHeight: 22,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        marginBottom: 40,
    },
    buttonContainer: {
        width: 280,
        maxWidth: '100%',
        marginBottom: 8,
    },
}));
