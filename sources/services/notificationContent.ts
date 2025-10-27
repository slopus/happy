import { Session } from '@/sync/storageTypes';
import { t } from '@/text';

export type NotificationType = 'permission' | 'input' | 'completion' | 'error';

export interface NotificationContentParams {
    session: Session;
    type: NotificationType;
    permissionName?: string;
    permissionReason?: string;
    customMessage?: string;
}

export interface NotificationContent {
    title: string;
    body: string;
}

/**
 * Get display name for a session
 * Priority: session.metadata.name > session summary > session ID
 */
export function getSessionDisplayName(session: Session): string {
    // 1. Use session name if available
    if (session.metadata?.name) {
        return session.metadata.name;
    }

    // 2. Use session summary if available
    if (session.metadata?.summary?.text) {
        const summary = session.metadata.summary.text;
        const preview = summary.slice(0, 30);
        return preview.length < summary.length ? `${preview}...` : preview;
    }

    // 3. Fallback to session ID (first 8 characters)
    return `Session ${session.id.slice(0, 8)}`;
}

/**
 * Generate specific notification content based on session state and type
 *
 * @param params - Notification parameters
 * @returns Notification title and body
 *
 * @example
 * ```typescript
 * const content = generateNotificationContent({
 *     session: mySession,
 *     type: 'permission',
 *     permissionName: 'file_system',
 *     permissionReason: 'read configuration files'
 * });
 * // Returns: {
 * //   title: '"My Project" needs permission',
 * //   body: 'Needs file_system permission: read configuration files'
 * // }
 * ```
 */
export function generateNotificationContent(
    params: NotificationContentParams
): NotificationContent {
    const sessionName = getSessionDisplayName(params.session);

    // Truncate session name for title (max 20 characters)
    const truncatedSessionName = sessionName.length > 20
        ? sessionName.slice(0, 20) + '...'
        : sessionName;

    switch (params.type) {
        case 'permission':
            return {
                // Title: "[Session Name]" needs permission
                title: t('notifications.permissionTitle', {
                    session: truncatedSessionName
                }),
                // Body: Needs [permission] permission: [reason]
                body: t('notifications.permissionBody', {
                    permission: params.permissionName || t('notifications.unknownPermission'),
                    reason: params.permissionReason || ''
                })
            };

        case 'input':
            return {
                // Title: "[Session Name]" waiting for input
                title: t('notifications.inputTitle', {
                    session: truncatedSessionName
                }),
                // Body: Custom message or default waiting message
                body: params.customMessage || t('notifications.waitingForCommand')
            };

        case 'completion':
            return {
                // Title: "[Session Name]" completed
                title: t('notifications.completionTitle', {
                    session: truncatedSessionName
                }),
                // Body: Custom completion message
                body: params.customMessage || t('notifications.taskCompletedDefault')
            };

        case 'error':
            return {
                // Title: "[Session Name]" encountered error
                title: t('notifications.errorTitle', {
                    session: truncatedSessionName
                }),
                // Body: Error message
                body: params.customMessage || t('notifications.unknownError')
            };
    }
}
