import * as React from 'react';
import { Platform, Linking } from 'react-native';
import { Modal } from '@/modal';
import { LinkPreviewModal } from '@/components/LinkPreviewModal';

/**
 * Hook that handles link presses across platforms.
 * On native (iOS/Android): Opens a WebView modal for preview
 * On web: Opens the link in a new browser tab
 */
export function useLinkHandler() {
    const handleLinkPress = React.useCallback((url: string) => {
        if (Platform.OS === 'web') {
            // Web: open in new tab
            window.open(url, '_blank', 'noopener,noreferrer');
        } else {
            // Native: show WebView modal for preview
            Modal.show({
                component: LinkPreviewModal,
                props: { url }
            });
        }
    }, []);

    const openInBrowser = React.useCallback(async (url: string) => {
        try {
            const canOpen = await Linking.canOpenURL(url);
            if (canOpen) {
                await Linking.openURL(url);
            }
        } catch (error) {
            console.error('Failed to open URL in browser:', error);
        }
    }, []);

    return { handleLinkPress, openInBrowser };
}
