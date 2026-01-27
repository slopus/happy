import { Platform } from 'react-native';
import { config } from '@/config';
import { RevenueCat, LogLevel } from '../revenueCat';

export async function syncPurchases(params: {
    serverID: string;
    revenueCatInitialized: boolean;
    setRevenueCatInitialized: (next: boolean) => void;
    // RevenueCat types are not exported consistently across platforms; keep this loose.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    applyPurchases: (customerInfo: any) => void;
}): Promise<void> {
    const { serverID, revenueCatInitialized, setRevenueCatInitialized, applyPurchases } = params;

    try {
        // Initialize RevenueCat if not already done
        if (!revenueCatInitialized) {
            // Get the appropriate API key based on platform
            let apiKey: string | undefined;

            if (Platform.OS === 'ios') {
                apiKey = config.revenueCatAppleKey;
            } else if (Platform.OS === 'android') {
                apiKey = config.revenueCatGoogleKey;
            } else if (Platform.OS === 'web') {
                apiKey = config.revenueCatStripeKey;
            }

            if (!apiKey) {
                return;
            }

            // Configure RevenueCat
            if (__DEV__) {
                RevenueCat.setLogLevel(LogLevel.DEBUG);
            }

            // Initialize with the public ID as user ID
            RevenueCat.configure({
                apiKey,
                appUserID: serverID, // In server this is a CUID, which we can assume is globaly unique even between servers
                useAmazon: false,
            });

            setRevenueCatInitialized(true);
        }

        // Sync purchases
        await RevenueCat.syncPurchases();

        // Fetch customer info
        const customerInfo = await RevenueCat.getCustomerInfo();

        // Apply to storage (storage handles the transformation)
        applyPurchases(customerInfo);
    } catch (error) {
        console.error('Failed to sync purchases:', error);
        // Don't throw - purchases are optional
    }
}
