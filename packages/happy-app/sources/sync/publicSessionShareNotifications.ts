import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { t } from '@/text';
import type { PublicSessionShareJob } from './publicSessionShareQueue';

export async function notifyPublicSessionShareJob(job: PublicSessionShareJob): Promise<void> {
    if (Platform.OS === 'web' || (job.status !== 'ready' && job.status !== 'failed')) return;
    const isReady = job.status === 'ready';
    await Notifications.scheduleNotificationAsync({
        content: {
            title: t(isReady ? 'sessionShare.readyNotificationTitle' : 'sessionShare.failedNotificationTitle'),
            body: t(isReady ? 'sessionShare.readyNotificationBody' : 'sessionShare.failedNotificationBody', { title: job.title }),
            data: {
                kind: isReady ? 'share-ready' : 'share-failed',
                sessionId: job.sessionId,
                url: `/session/${encodeURIComponent(job.sessionId)}`,
                ...(job.publicId ? { publicId: job.publicId } : {}),
            },
            sound: true,
            ...(Platform.OS === 'android' ? { badge: 1 } : {}),
        },
        trigger: { channelId: 'messages' },
    });
}
