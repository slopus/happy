import React, { useState, useEffect, useRef } from 'react';
import { Platform, View, Text, ScrollView, ActivityIndicator } from 'react-native';
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

const QR_SIZE = 260;

const stylesheet = StyleSheet.create((theme) => ({
    scrollView: {
        flex: 1,
        backgroundColor: Platform.select({ web: theme.colors.surface, default: 'transparent' }),
    },
    container: {
        flexGrow: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 32,
        paddingVertical: 24,
    },
    instruction: {
        ...Typography.default(),
        fontSize: 17,
        lineHeight: 22,
        color: theme.colors.text,
        textAlign: 'center',
        marginBottom: 8,
    },
    path: {
        ...Typography.default(),
        fontSize: 15,
        lineHeight: 20,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        marginBottom: 32,
    },
    qrPlaceholder: {
        width: QR_SIZE,
        height: QR_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 16,
        backgroundColor: Platform.select({ web: theme.colors.surface, default: theme.colors.surfaceHigh }),
    },
    qrFrame: {
        padding: 12,
        borderRadius: 16,
        backgroundColor: 'white',
    },
    buttonContainer: {
        width: 280,
        maxWidth: '100%',
        marginTop: 32,
    },
}));

/**
 * Restore by scanning from another phone that already has the account.
 * The QR here is scanned by the other device, not by this one.
 */
export default function Restore() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const auth = useAuth();
    const router = useRouter();
    const [authReady, setAuthReady] = useState(false);
    const isCancelledRef = useRef(false);

    // Memoize keypair generation to prevent re-creating on re-renders
    const keypair = React.useMemo(() => generateAuthKeyPair(), []);

    // Start QR authentication when component mounts
    useEffect(() => {
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
                    () => {},
                    () => isCancelledRef.current
                );

                if (credentials && !isCancelledRef.current) {
                    // Convert secret bytes to base64url string for login
                    const secretString = encodeBase64(credentials.secret, 'base64url');
                    await auth.login(credentials.token, secretString);
                    if (!isCancelledRef.current) {
                        // Straight home: the home route now renders the
                        // signed-in state, and there is no restore screen to
                        // return to.
                        router.dismissTo('/');
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
    }, [keypair]);

    return (
        <ScrollView style={styles.scrollView} contentContainerStyle={styles.container}>
            <Text style={styles.instruction}>{t('onboarding.restoreScan')}</Text>
            <Text style={styles.path}>{t('onboarding.restoreScanPath')}</Text>
            {authReady ? (
                <View style={styles.qrFrame}>
                    <QRCode
                        data={'happy:///account?' + encodeBase64(keypair.publicKey, 'base64url')}
                        size={QR_SIZE}
                        foregroundColor={'black'}
                        backgroundColor={'white'}
                    />
                </View>
            ) : (
                <View style={styles.qrPlaceholder}>
                    <ActivityIndicator size="small" color={theme.colors.text} />
                </View>
            )}
            <View style={styles.buttonContainer}>
                <RoundButton
                    size="normal"
                    display="inverted"
                    title={t('onboarding.restoreUseKey')}
                    onPress={() => router.push('/restore/manual')}
                />
            </View>
        </ScrollView>
    );
}
