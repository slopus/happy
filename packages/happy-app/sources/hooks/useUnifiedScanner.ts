import * as React from 'react';
import { Linking } from 'react-native';
import { useAuth } from '@/auth/AuthContext';
import { decodeBase64 } from '@/encryption/base64';
import { encryptBox } from '@/encryption/libsodium';
import { authApprove } from '@/auth/authApprove';
import { authAccountApprove } from '@/auth/authAccountApprove';
import { useQRScanner } from '@/hooks/useQRScanner';
import { Modal } from '@/modal';
import { t } from '@/text';
import { sync } from '@/sync/sync';

const URL_REGEX = /^https?:\/\//i;

export function useUnifiedScanner() {
    const auth = useAuth();
    const [isLoading, setIsLoading] = React.useState(false);

    const processUrl = React.useCallback(async (url: string) => {
        if (url.startsWith('happy://terminal?')) {
            if (!auth.credentials) {
                Modal.alert(t('common.error'), t('errors.notAuthenticated'), [{ text: t('common.ok') }]);
                return false;
            }
            setIsLoading(true);
            try {
                const tail = url.slice('happy://terminal?'.length);
                const publicKey = decodeBase64(tail, 'base64url');
                const responseV1 = encryptBox(decodeBase64(auth.credentials.secret, 'base64url'), publicKey);
                let responseV2Bundle = new Uint8Array(sync.encryption.contentDataKey.length + 1);
                responseV2Bundle[0] = 0;
                responseV2Bundle.set(sync.encryption.contentDataKey, 1);
                const responseV2 = encryptBox(responseV2Bundle, publicKey);
                await authApprove(auth.credentials.token, publicKey, responseV1, responseV2);
                Modal.alert(t('common.success'), t('modals.terminalConnectedSuccessfully'), [{ text: t('common.ok') }]);
                return true;
            } catch (e) {
                console.error(e);
                Modal.alert(t('common.error'), t('modals.failedToConnectTerminal'), [{ text: t('common.ok') }]);
                return false;
            } finally {
                setIsLoading(false);
            }
        } else if (url.startsWith('happy:///account?')) {
            if (!auth.credentials) {
                Modal.alert(t('common.error'), t('errors.notAuthenticated'), [{ text: t('common.ok') }]);
                return false;
            }
            setIsLoading(true);
            try {
                const tail = url.slice('happy:///account?'.length);
                const publicKey = decodeBase64(tail, 'base64url');
                const response = encryptBox(decodeBase64(auth.credentials.secret, 'base64url'), publicKey);
                await authAccountApprove(auth.credentials.token, publicKey, response);
                Modal.alert(t('common.success'), t('modals.deviceLinkedSuccessfully'), [{ text: t('common.ok') }]);
                return true;
            } catch (e) {
                console.error(e);
                Modal.alert(t('common.error'), t('modals.failedToLinkDevice'), [{ text: t('common.ok') }]);
                return false;
            } finally {
                setIsLoading(false);
            }
        } else if (URL_REGEX.test(url)) {
            Linking.openURL(url);
            return true;
        } else {
            Modal.alert(t('common.error'), t('modals.unrecognizedQrCode', { content: url }), [{ text: t('common.ok') }]);
            return false;
        }
    }, [auth.credentials]);

    const { launchScanner } = useQRScanner((code) => {
        processUrl(code);
    });

    return {
        launchScanner,
        connectWithUrl: processUrl,
        isLoading,
    };
}
