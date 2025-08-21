import * as StoreReview from 'expo-store-review';
import { MMKV } from 'react-native-mmkv';
import { Modal } from '@/modal';
import { AsyncLock } from './lock';
import {
    trackReviewPromptShown,
    trackReviewPromptResponse,
    trackReviewStoreShown,
    trackReviewRetryScheduled
} from '@/track';
import { sync } from '@/sync/sync';
import { storage as syncStorage } from '@/sync/storage';
import { Platform } from 'react-native';

const localStorage = new MMKV();

const LOCAL_KEYS = {
    STORE_REVIEW_LAST_SHOWN: 'review_store_last_shown',
    DECLINED_AT: 'review_declined_at',
} as const;

const RETRY_DAYS = 30;
const STORE_REVIEW_RETRY_DAYS = 7; // Allow store review again after a week
const DAY_IN_MS = 24 * 60 * 60 * 1000;
const lock = new AsyncLock();

export function requestReview() {
    if (Platform.OS === 'web') {
        return;
    }

    lock.inLock(async () => {
        try {

            // Check if store review is available
            const isAvailable = await StoreReview.isAvailableAsync();
            if (!isAvailable) {
                console.log('Store review is not available on this platform');
                return;
            }

            const settings = syncStorage.getState().settings;

            // Check if we should show store review directly (user already answered and liked the app)
            if (settings.reviewPromptAnswered && settings.reviewPromptLikedApp) {
                // Check if enough time has passed since last store review
                const lastShownStr = localStorage.getString(LOCAL_KEYS.STORE_REVIEW_LAST_SHOWN);
                if (lastShownStr) {
                    const lastShown = new Date(lastShownStr);
                    const now = new Date();
                    const daysSinceShown = (now.getTime() - lastShown.getTime()) / DAY_IN_MS;

                    if (daysSinceShown < STORE_REVIEW_RETRY_DAYS) {
                        // Not enough time has passed since last store review
                        return;
                    }
                }

                await StoreReview.requestReview();
                trackReviewStoreShown();
                localStorage.set(LOCAL_KEYS.STORE_REVIEW_LAST_SHOWN, new Date().toISOString());
                return;
            }

            // Check if user already answered the prompt (synced across devices)
            if (settings.reviewPromptAnswered) {
                // User already answered on another device, don't ask again
                return;
            }

            // Check if user previously declined and if it's been 30 days (local check)
            const declinedAtStr = localStorage.getString(LOCAL_KEYS.DECLINED_AT);
            if (declinedAtStr) {
                const declinedAt = new Date(declinedAtStr);
                const now = new Date();
                const daysSinceDeclined = (now.getTime() - declinedAt.getTime()) / DAY_IN_MS;

                if (daysSinceDeclined < RETRY_DAYS) {
                    // Not enough time has passed since last decline
                    return;
                }
            }

            // Pre-ask if they like the app (only shown once, ever)
            trackReviewPromptShown();
            const likesApp = await Modal.confirm(
                'Enjoying the app?',
                'We\'d love to hear your feedback!',
                {
                    confirmText: 'Yes, I love it!',
                    cancelText: 'Not really',
                }
            );
            trackReviewPromptResponse(likesApp);

            // Store the answer in sync settings (synced across devices)
            sync.applySettings({
                reviewPromptAnswered: true,
                reviewPromptLikedApp: likesApp,
            });

            if (!likesApp) {
                // User doesn't like the app, store the timestamp locally
                localStorage.set(LOCAL_KEYS.DECLINED_AT, new Date().toISOString());

                // Track that we'll retry in 30 days
                trackReviewRetryScheduled(RETRY_DAYS);
                return;
            }

            // Request the actual store review directly
            await StoreReview.requestReview();
            trackReviewStoreShown();

            // Mark when we last showed the store review
            localStorage.set(LOCAL_KEYS.STORE_REVIEW_LAST_SHOWN, new Date().toISOString());

        } catch (error) {
            console.error('Error requesting review:', error);
        }
    });
}

// Optional: Reset review state for testing
export function resetReviewState(): void {
    localStorage.delete(LOCAL_KEYS.DECLINED_AT);
    localStorage.delete(LOCAL_KEYS.STORE_REVIEW_LAST_SHOWN);

    // Reset sync settings
    sync.applySettings({
        reviewPromptAnswered: false,
        reviewPromptLikedApp: null,
    });
}