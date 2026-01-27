import { Platform } from 'react-native';
import { config } from '@/config';
import { RevenueCat, LogLevel, PaywallResult } from '../revenueCat';

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

export async function purchaseProduct(params: {
    revenueCatInitialized: boolean;
    productId: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    applyPurchases: (customerInfo: any) => void;
}): Promise<{ success: boolean; error?: string }> {
    const { revenueCatInitialized, productId, applyPurchases } = params;

    try {
        // Check if RevenueCat is initialized
        if (!revenueCatInitialized) {
            return { success: false, error: 'RevenueCat not initialized' };
        }

        // Fetch the product
        const products = await RevenueCat.getProducts([productId]);
        if (products.length === 0) {
            return { success: false, error: `Product '${productId}' not found` };
        }

        // Purchase the product
        const product = products[0];
        const { customerInfo } = await RevenueCat.purchaseStoreProduct(product);

        // Update local purchases data
        applyPurchases(customerInfo);

        return { success: true };
    } catch (error: any) {
        // Check if user cancelled
        if (error.userCancelled) {
            return { success: false, error: 'Purchase cancelled' };
        }

        // Return the error message
        return { success: false, error: error.message || 'Purchase failed' };
    }
}

export async function getOfferings(params: {
    revenueCatInitialized: boolean;
}): Promise<{ success: boolean; offerings?: any; error?: string }> {
    const { revenueCatInitialized } = params;

    try {
        // Check if RevenueCat is initialized
        if (!revenueCatInitialized) {
            return { success: false, error: 'RevenueCat not initialized' };
        }

        // Fetch offerings
        const offerings = await RevenueCat.getOfferings();

        // Return the offerings data
        return {
            success: true,
            offerings: {
                current: offerings.current,
                all: offerings.all,
            },
        };
    } catch (error: any) {
        return { success: false, error: error.message || 'Failed to fetch offerings' };
    }
}

export async function presentPaywall(params: {
    revenueCatInitialized: boolean;
    trackPaywallPresented: () => void;
    trackPaywallPurchased: () => void;
    trackPaywallCancelled: () => void;
    trackPaywallRestored: () => void;
    trackPaywallError: (error: string) => void;
    syncPurchases: () => Promise<void>;
}): Promise<{ success: boolean; purchased?: boolean; error?: string }> {
    const {
        revenueCatInitialized,
        trackPaywallPresented,
        trackPaywallPurchased,
        trackPaywallCancelled,
        trackPaywallRestored,
        trackPaywallError,
        syncPurchases,
    } = params;

    try {
        // Check if RevenueCat is initialized
        if (!revenueCatInitialized) {
            const error = 'RevenueCat not initialized';
            trackPaywallError(error);
            return { success: false, error };
        }

        // Track paywall presentation
        trackPaywallPresented();

        // Present the paywall
        const result = await RevenueCat.presentPaywall();

        // Handle the result
        switch (result) {
            case PaywallResult.PURCHASED:
                trackPaywallPurchased();
                // Refresh customer info after purchase
                await syncPurchases();
                return { success: true, purchased: true };
            case PaywallResult.RESTORED:
                trackPaywallRestored();
                // Refresh customer info after restore
                await syncPurchases();
                return { success: true, purchased: true };
            case PaywallResult.CANCELLED:
                trackPaywallCancelled();
                return { success: true, purchased: false };
            case PaywallResult.NOT_PRESENTED:
                // Don't track error for NOT_PRESENTED as it's a platform limitation
                return { success: false, error: 'Paywall not available on this platform' };
            case PaywallResult.ERROR:
            default: {
                const errorMsg = 'Failed to present paywall';
                trackPaywallError(errorMsg);
                return { success: false, error: errorMsg };
            }
        }
    } catch (error: any) {
        const errorMessage = error.message || 'Failed to present paywall';
        trackPaywallError(errorMessage);
        return { success: false, error: errorMessage };
    }
}
