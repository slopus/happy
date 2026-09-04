import * as React from 'react';
import { Platform } from 'react-native';
import { CameraView } from 'expo-camera';
import { getAuthQrCodeKind } from '@/auth/authQrCodeKind';
import { useCheckScannerPermissions } from '@/hooks/useCheckCameraPermissions';
import { useConnectAccount } from '@/hooks/useConnectAccount';
import { useConnectTerminal } from '@/hooks/useConnectTerminal';
import { Modal } from '@/modal';
import { t } from '@/text';

interface UnifiedAuthQrCodeContextValue {
    connectAuthQrCode: () => Promise<void>;
    connectWithUrl: (url: string) => Promise<boolean>;
    isLoading: boolean;
}

const UnifiedAuthQrCodeContext = React.createContext<UnifiedAuthQrCodeContextValue | null>(null);

// Native scanner presentation can outlive the authenticated React tree. Keep
// ownership at module scope so a replacement provider can close an orphaned
// iOS scanner before accepting another scan request.
const scannerSession = {
    active: false,
    dismissal: null as Promise<boolean> | null,
    generation: 0,
    launching: null as Promise<void> | null,
};

let authenticationInFlight = false;

function showScannerUnavailableAlert() {
    Modal.alert(t('common.error'), t('modals.cameraPermissionsRequiredToScanQr'), [
        { text: t('common.ok') },
    ]);
}

function isScannerCancellation(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }

    const { code, message } = error as { code?: unknown; message?: unknown };
    return (typeof code === 'string' && code.includes('BARCODE_SCANNING_CANCELLED'))
        || (typeof message === 'string' && message.includes('Barcode scanning was cancelled'));
}

export function UnifiedAuthQrCodeProvider({ children }: { children: React.ReactNode }) {
    const checkScannerPermissions = useCheckScannerPermissions();
    const account = useConnectAccount();
    const terminal = useConnectTerminal();
    const isMountedRef = React.useRef(true);
    const isStartingScannerRef = React.useRef(false);
    const ownedScannerGenerationRef = React.useRef<number | null>(null);
    const [isStartingScanner, setIsStartingScanner] = React.useState(false);

    const processAuthUrl = React.useCallback(async (url: string) => {
        const kind = getAuthQrCodeKind(url);
        if (!kind) {
            Modal.alert(t('common.error'), t('modals.invalidAuthUrl'), [
                { text: t('common.ok') },
            ]);
            return false;
        }

        const confirmed = await Modal.confirm(
            kind === 'account' ? t('navigation.linkNewDevice') : t('navigation.connectTerminal'),
            kind === 'account'
                ? t('settingsAccount.linkNewDeviceSubtitle')
                : t('terminal.terminalRequestDescription'),
            {
                cancelText: t('common.cancel'),
                confirmText: t('common.continue'),
            },
        );
        if (!confirmed || !isMountedRef.current) {
            return false;
        }

        return kind === 'account'
            ? account.processAuthUrl(url)
            : terminal.processAuthUrl(url);
    }, [account.processAuthUrl, terminal.processAuthUrl]);

    const runAuthentication = React.useCallback(async (operation: () => Promise<boolean>) => {
        if (authenticationInFlight) {
            return false;
        }

        authenticationInFlight = true;
        try {
            return await operation();
        } finally {
            authenticationInFlight = false;
        }
    }, []);

    const connectWithUrl = React.useCallback(async (url: string) => {
        return runAuthentication(() => processAuthUrl(url));
    }, [processAuthUrl, runAuthentication]);

    const dismissOwnedScanner = React.useCallback((): Promise<boolean> => {
        if (scannerSession.dismissal) {
            return scannerSession.dismissal;
        }

        if (!scannerSession.active) {
            return Promise.resolve(true);
        }

        scannerSession.active = false;
        if (Platform.OS !== 'ios') {
            return Promise.resolve(true);
        }

        const dismissal = CameraView.dismissScanner()
            .then(() => true)
            .catch((error: unknown) => {
                scannerSession.active = true;
                console.warn('Failed to dismiss authentication scanner', error);
                return false;
            })
            .finally(() => {
                if (scannerSession.dismissal === dismissal) {
                    scannerSession.dismissal = null;
                }
            });
        scannerSession.dismissal = dismissal;
        return dismissal;
    }, []);

    const connectAuthQrCode = React.useCallback(async () => {
        if (isStartingScannerRef.current) {
            return;
        }

        isStartingScannerRef.current = true;
        setIsStartingScanner(true);
        try {
            if (!CameraView.isModernBarcodeScannerAvailable || !await checkScannerPermissions()) {
                if (isMountedRef.current) {
                    showScannerUnavailableAlert();
                }
                return;
            }

            if (!isMountedRef.current) {
                return;
            }

            const pendingLaunch = scannerSession.launching;
            if (pendingLaunch) {
                await pendingLaunch;
            }

            if (!isMountedRef.current) {
                return;
            }

            while (scannerSession.dismissal) {
                await scannerSession.dismissal;
            }

            if (!isMountedRef.current) {
                return;
            }

            if (scannerSession.active && !await dismissOwnedScanner()) {
                return;
            }

            if (!isMountedRef.current) {
                return;
            }

            const generation = scannerSession.generation + 1;
            scannerSession.generation = generation;
            ownedScannerGenerationRef.current = generation;
            scannerSession.active = true;

            const nativeLaunch = CameraView.launchScanner({ barcodeTypes: ['qr'] });
            const trackedLaunch = nativeLaunch
                .then(
                    () => {
                        if (scannerSession.generation === generation && Platform.OS !== 'ios') {
                            scannerSession.active = false;
                        }
                    },
                    () => {
                        if (scannerSession.generation === generation && Platform.OS !== 'ios') {
                            scannerSession.active = false;
                        }
                    },
                )
                .finally(() => {
                    if (scannerSession.launching === trackedLaunch) {
                        scannerSession.launching = null;
                    }
                });
            scannerSession.launching = trackedLaunch;
            await nativeLaunch;
        } catch (error) {
            const ownedGeneration = ownedScannerGenerationRef.current;
            if (
                Platform.OS !== 'ios'
                && ownedGeneration !== null
                && scannerSession.generation === ownedGeneration
            ) {
                scannerSession.active = false;
            }
            if (isMountedRef.current && !isScannerCancellation(error)) {
                console.warn('Failed to launch authentication scanner', error);
                showScannerUnavailableAlert();
            }
        } finally {
            isStartingScannerRef.current = false;
            if (isMountedRef.current) {
                setIsStartingScanner(false);
            }
        }
    }, [checkScannerPermissions, dismissOwnedScanner]);

    React.useEffect(() => {
        isMountedRef.current = true;
        if (Platform.OS === 'ios' && (scannerSession.active || scannerSession.dismissal)) {
            void (async () => {
                const pendingLaunch = scannerSession.launching;
                if (pendingLaunch) {
                    await pendingLaunch;
                }
                const dismissed = await dismissOwnedScanner();
                if (!dismissed) {
                    await dismissOwnedScanner();
                }
            })();
        }
        return () => {
            isMountedRef.current = false;
            const ownedGeneration = ownedScannerGenerationRef.current;
            ownedScannerGenerationRef.current = null;
            if (ownedGeneration !== null && scannerSession.generation === ownedGeneration) {
                scannerSession.generation += 1;
            }
        };
    }, [dismissOwnedScanner]);

    // The provider is mounted once for the authenticated app, so every entry point
    // shares one scanner subscription and one authentication single-flight guard.
    React.useEffect(() => {
        if (!CameraView.isModernBarcodeScannerAvailable) {
            return;
        }

        const subscription = CameraView.onModernBarcodeScanned(async (event) => {
            if (!scannerSession.active) {
                return;
            }

            let scannerDismissed = await dismissOwnedScanner();
            if (!scannerDismissed) {
                scannerDismissed = await dismissOwnedScanner();
            }
            if (!scannerDismissed || !isMountedRef.current) {
                return;
            }

            await runAuthentication(() => processAuthUrl(event.data));
        });

        return () => {
            subscription.remove();
            void (async () => {
                const pendingLaunch = scannerSession.launching;
                if (pendingLaunch) {
                    await pendingLaunch;
                }
                const dismissed = await dismissOwnedScanner();
                if (!dismissed) {
                    await dismissOwnedScanner();
                }
            })();
        };
    }, [dismissOwnedScanner, processAuthUrl, runAuthentication]);

    const value = React.useMemo<UnifiedAuthQrCodeContextValue>(() => ({
        connectAuthQrCode,
        connectWithUrl,
        isLoading: isStartingScanner || account.isLoading || terminal.isLoading,
    }), [account.isLoading, connectAuthQrCode, connectWithUrl, isStartingScanner, terminal.isLoading]);

    return React.createElement(UnifiedAuthQrCodeContext.Provider, { value }, children);
}

export function useUnifiedAuthQrCode(): UnifiedAuthQrCodeContextValue {
    const value = React.useContext(UnifiedAuthQrCodeContext);
    if (!value) {
        throw new Error('useUnifiedAuthQrCode must be used within UnifiedAuthQrCodeProvider');
    }
    return value;
}
