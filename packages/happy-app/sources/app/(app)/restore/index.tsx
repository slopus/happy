import React, { useState, useEffect, useRef } from 'react';
import { View, Text, ScrollView, ActivityIndicator, useWindowDimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { RoundButton } from '@/components/RoundButton';
import { Typography } from '@/constants/Typography';
import { encodeBase64 } from '@/encryption/base64';
import { generateAuthKeyPair, authQRStart } from '@/auth/authQRStart';
import { authQRWait } from '@/auth/authQRWait';
import { Modal } from '@/modal';
import { t } from '@/text';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { QRCode } from '@/components/qr/QRCode';
import { getRestoreLayout } from '@/utils/restoreLayout';

const stylesheet = StyleSheet.create((theme) => ({
    scrollView: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
    container: {
        flex: 1,
        alignItems: 'center',
        paddingHorizontal: 24,
    },
    contentWrapper: {
        width: '100%',
        maxWidth: 1040,
        flexGrow: 1,
        justifyContent: 'center',
        paddingVertical: 40,
    },
    desktopContent: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 72,
    },
    instructionsPanel: {
        width: '100%',
        maxWidth: 380,
    },
    qrPanel: {
        width: '100%',
        maxWidth: 400,
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 28,
        paddingHorizontal: 24,
        borderRadius: 24,
        backgroundColor: theme.colors.surfaceHigh,
    },
    instructionText: {
        fontSize: 28,
        color: theme.colors.text,
        marginBottom: 16,
        ...Typography.default('semiBold'),
    },
    secondInstructionText: {
        fontSize: 16,
        color: theme.colors.textSecondary,
        marginBottom: 0,
        lineHeight: 26,
        ...Typography.default(),
    },
    qrFrame: {
        width: 316,
        height: 316,
        maxWidth: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#ffffff',
        borderRadius: 20,
        overflow: 'hidden',
    },
    restoreAction: {
        marginTop: 24,
        minWidth: 280,
        maxWidth: '100%',
    },
    compactContent: {
        alignItems: 'center',
        paddingVertical: 24,
    },
    compactInstructions: {
        alignItems: 'center',
        marginBottom: 24,
    },
    compactTitle: {
        textAlign: 'center',
        fontSize: 22,
    },
    compactSteps: {
        textAlign: 'left',
    },
}));

export default function Restore() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const auth = useAuth();
    const router = useRouter();
    const [authReady, setAuthReady] = useState(false);
    const [, setWaitingDots] = useState(0);
    const isCancelledRef = useRef(false);
    const { width: viewportWidth } = useWindowDimensions();
    const isDesktop = getRestoreLayout(viewportWidth) === 'desktop';

    // Memoize keypair generation to prevent re-creating on re-renders
    const keypair = React.useMemo(() => generateAuthKeyPair(), []);

    // Start QR authentication when component mounts
    useEffect(() => {
        if (auth.isAuthenticated) {
            router.replace('/');
            return;
        }

        const startQRAuth = async () => {
            try {
                // Send authentication request
                const success = await authQRStart(keypair);
                if (!success) {
                    Modal.alert(t('common.error'), t('errors.authenticationFailed'));
                    return;
                }

                setAuthReady(true);

                // Start waiting for authentication
                const credentials = await authQRWait(
                    keypair,
                    (dots) => setWaitingDots(dots),
                    () => isCancelledRef.current
                );

                if (credentials && !isCancelledRef.current) {
                    // Convert secret bytes to base64url string for login
                    const secretString = encodeBase64(credentials.secret, 'base64url');
                    await auth.login(credentials.token, secretString);
                    if (!isCancelledRef.current) {
                        router.replace('/');
                    }
                } else if (!isCancelledRef.current) {
                    Modal.alert(t('common.error'), t('errors.authenticationFailed'));
                }

            } catch (error) {
                if (!isCancelledRef.current) {
                    console.error('QR Auth error:', error);
                    Modal.alert(t('common.error'), t('errors.authenticationFailed'));
                }
            } finally {
                if (!isCancelledRef.current) {
                    setAuthReady(false);
                }
            }
        };

        startQRAuth();

        // Cleanup function
        return () => {
            isCancelledRef.current = true;
        };
    }, [auth.isAuthenticated, keypair, router]);

    return (
        <ScrollView style={styles.scrollView} contentContainerStyle={{ flexGrow: 1 }}>
            <View style={styles.container}>
                <View
                    testID="restore-device-content"
                    style={[
                        styles.contentWrapper,
                        isDesktop ? styles.desktopContent : styles.compactContent,
                    ]}
                >
                    <View
                        testID="restore-device-instructions"
                        style={[
                            styles.instructionsPanel,
                            !isDesktop && styles.compactInstructions,
                        ]}
                    >
                        <Text style={[styles.instructionText, !isDesktop && styles.compactTitle]}>
                            {t('settingsAccount.linkNewDeviceSubtitle')}
                        </Text>
                        <Text style={[styles.secondInstructionText, !isDesktop && styles.compactSteps]}>
                            1. Open Paws on your mobile device{'\n'}
                            2. Go to Settings → Account{'\n'}
                            3. Tap "Link New Device"{'\n'}
                            4. Scan this QR code
                        </Text>
                    </View>
                    <View testID="restore-device-qr-panel" style={styles.qrPanel}>
                        <View style={styles.qrFrame}>
                            {!authReady && (
                                <ActivityIndicator size="small" color={theme.colors.text} />
                            )}
                            {authReady && (
                                <View testID="restore-device-qr-code">
                                    <QRCode
                                        data={'paws:///account?' + encodeBase64(keypair.publicKey, 'base64url')}
                                        size={280}
                                        foregroundColor={'black'}
                                        backgroundColor={'white'}
                                    />
                                </View>
                            )}
                        </View>
                        <RoundButton
                            title="Restore with Secret Key Instead"
                            display="inverted"
                            size="normal"
                            style={styles.restoreAction}
                            onPress={() => {
                                router.push('/restore/manual');
                            }}
                        />
                    </View>
                </View>
            </View>
        </ScrollView>
    );
}
