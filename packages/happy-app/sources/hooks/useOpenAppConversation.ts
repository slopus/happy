import * as React from 'react';
import { Linking, Platform } from 'react-native';
import { sync } from '@/sync/sync';
import { getServerUrl } from '@/sync/serverConfig';
import { appAuthorizationRequest, type AppConversationEntry, type AppAuthorizationGrant } from '@/sync/apiAppDelegation';
import { appConversationHistoryUrl, type AppConversationAccess } from '@/sync/appConversationHistory';
import { useHappyAction } from '@/hooks/useHappyAction';
import { HappyError } from '@/utils/errors';
import { t } from '@/text';

/** Reserve the web tab during the user gesture; never deliver credentials after owner changes. */
export function useOpenAppConversation(token?: string) {
    const server = getServerUrl();
    const owner = React.useRef({ token, server });
    owner.current = { token, server };
    const request = React.useRef<AbortController | null>(null);
    const [openingId, setOpeningId] = React.useState<string | null>(null);
    React.useEffect(() => () => { request.current?.abort(); }, [token, server]);
    const [loading, open] = useHappyAction(async (conversation: AppConversationEntry, grant: AppAuthorizationGrant) => {
        if (!token) return;
        const controller = new AbortController();
        request.current = controller;
        let popup: Window | null = null;
        try {
            // Keep this before the first await: otherwise browsers block the new tab.
            if (Platform.OS === 'web') {
                popup = window.open('about:blank', '_blank');
                if (!popup) throw new HappyError(t('appConversations.popupBlocked'), false);
                popup.opener = null;
                popup.document.title = t('appConversations.opening');
                popup.document.body.textContent = t('appConversations.opening');
            }
            setOpeningId(conversation.id);
            const access = await appAuthorizationRequest<AppConversationAccess>(token, `/conversations/${conversation.id}/open`, {}, 'POST', controller.signal);
            const encryption = sync.encryption.getMachineEncryption(grant.machineId ?? '');
            if (!encryption) throw new HappyError(t('appConversations.keyUnavailable'), false);
            const envelope = await encryption.decryptRaw(access.machineEnvelope);
            if (!envelope) throw new HappyError(t('appConversations.keyUnavailable'), false);
            const url = appConversationHistoryUrl(access, envelope, { conversationId: conversation.id, grantId: grant.id, machineId: grant.machineId });
            if (controller.signal.aborted || owner.current.token !== token || owner.current.server !== server || getServerUrl() !== server) { popup?.close(); return; }
            if (Platform.OS === 'web') {
                if (popup?.closed) return;
                popup!.location.replace(url);
            } else await Linking.openURL(url);
        } catch (error) {
            popup?.close();
            if (!controller.signal.aborted) throw error;
        } finally {
            if (request.current === controller) request.current = null;
            if (!controller.signal.aborted) setOpeningId(null);
        }
    }, { fallbackErrorMessage: t('appConversations.openFailed') });
    return { open, openingId: loading ? openingId : null, loading };
}
