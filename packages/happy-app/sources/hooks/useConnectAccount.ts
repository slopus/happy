import * as React from 'react';
import { Platform } from 'react-native';
import { CameraView } from 'expo-camera';
import { useAuth } from '@/auth/AuthContext';
import { decodeBase64 } from '@/encryption/base64';
import { encryptBox } from '@/encryption/libsodium';
import { authAccountApprove } from '@/auth/authAccountApprove';
import { useCheckScannerPermissions } from '@/hooks/useCheckCameraPermissions';
import { Modal } from '@/modal';
import { t } from '@/text';

interface UseConnectAccountOptions {
    onSuccess?: () => void;
    onError?: (error: any) => void;
}

export function useConnectAccount(options?: UseConnectAccountOptions) {
    const auth = useAuth();
    const [isLoading, setIsLoading] = React.useState(false);
    const checkScannerPermissions = useCheckScannerPermissions();

    const processAuthUrl = React.useCallback(async (url: string) => {
        if (!url.startsWith('happy:///account?')) {
            Modal.alert(t('common.error'), t('modals.invalidAuthUrl'), [{ text: t('common.ok') }]);
            return false;
        }
        
        setIsLoading(true);
        try {
            const tail = url.slice('happy:///account?'.length);
            const publicKey = decodeBase64(tail, 'base64url');
            const response = encryptBox(decodeBase64(auth.credentials!.secret, 'base64url'), publicKey);
            await authAccountApprove(auth.credentials!.token, publicKey, response);
            
            Modal.alert(t('common.success'), t('modals.deviceLinkedSuccessfully'), [
                { 
                    text: t('common.ok'), 
                    onPress: () => options?.onSuccess?.()
                }
            ]);
            return true;
        } catch (e) {
            console.error(e);
            Modal.alert(t('common.error'), t('modals.failedToLinkDevice'), [{ text: t('common.ok') }]);
            options?.onError?.(e);
            return false;
        } finally {
            setIsLoading(false);
        }
    }, [auth.credentials, options]);

    const connectAccount = React.useCallback(async () => {
        if (await checkScannerPermissions()) {
            // Use camera scanner
            CameraView.launchScanner({
                barcodeTypes: ['qr']
            });
        } else {
            Modal.alert(t('common.error'), t('modals.cameraPermissionsRequiredToScanQr'), [{ text: t('common.ok') }]);
        }
    }, [checkScannerPermissions]);

    const connectWithUrl = React.useCallback(async (url: string) => {
        return await processAuthUrl(url);
    }, [processAuthUrl]);

    // Set up barcode scanner listener
    const isProcessingRef = React.useRef(false);
    React.useEffect(() => {
        if (CameraView.isModernBarcodeScannerAvailable) {
            const subscription = CameraView.onModernBarcodeScanned(async (event) => {
                if (isProcessingRef.current) return;
                if (event.data.startsWith('happy:///account?')) {
                    isProcessingRef.current = true;
                    try {
                        if (Platform.OS === 'ios') {
                            try {
                                await CameraView.dismissScanner();
                            } catch (e) {
                                console.warn('Failed to dismiss scanner', e);
                            }
                        }
                        await processAuthUrl(event.data);
                    } finally {
                        isProcessingRef.current = false;
                    }
                }
            });
            return () => {
                subscription.remove();
                isProcessingRef.current = false;
                if (Platform.OS === 'ios') {
                    CameraView.dismissScanner().catch((e: unknown) => {
                        console.warn('Failed to dismiss scanner during cleanup', e);
                    });
                }
            };
        }
    }, [processAuthUrl]);

    return {
        connectAccount,
        connectWithUrl,
        isLoading,
        processAuthUrl
    };
}
