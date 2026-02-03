import Purchases, { 
    CustomerInfo as NativeCustomerInfo,
    PurchasesOfferings,
    PurchasesStoreProduct,
    LOG_LEVEL
} from 'react-native-purchases';
import RevenueCatUI, { PAYWALL_RESULT } from 'react-native-purchases-ui';
import { 
    RevenueCatInterface, 
    CustomerInfo, 
    Product, 
    Offerings, 
    PurchaseResult,
    RevenueCatConfig,
    LogLevel,
    PaywallResult,
    PaywallOptions
} from './types';

// Map native log levels to our common ones
const logLevelMap = {
    [LogLevel.VERBOSE]: LOG_LEVEL.VERBOSE,
    [LogLevel.DEBUG]: LOG_LEVEL.DEBUG,
    [LogLevel.INFO]: LOG_LEVEL.INFO,
    [LogLevel.WARN]: LOG_LEVEL.WARN,
    [LogLevel.ERROR]: LOG_LEVEL.ERROR
};

class RevenueCatNative implements RevenueCatInterface {
    configure(config: RevenueCatConfig): void {
        Purchases.configure({
            apiKey: config.apiKey,
            appUserID: config.appUserID,
            useAmazon: config.useAmazon || false
        });
    }

    async getCustomerInfo(): Promise<CustomerInfo> {
        const nativeInfo = await Purchases.getCustomerInfo();
        return this.transformCustomerInfo(nativeInfo);
    }

    async getOfferings(): Promise<Offerings> {
        const nativeOfferings = await Purchases.getOfferings();
        return this.transformOfferings(nativeOfferings);
    }

    async getProducts(productIds: string[]): Promise<Product[]> {
        const nativeProducts = await Purchases.getProducts(productIds);
        return nativeProducts.map(p => this.transformProduct(p));
    }

    async purchaseStoreProduct(product: Product): Promise<PurchaseResult> {
        // For native, we need to get the actual native product object
        const nativeProducts = await Purchases.getProducts([product.identifier]);
        if (nativeProducts.length === 0) {
            throw new Error(`Product ${product.identifier} not found`);
        }
        
        const result = await Purchases.purchaseStoreProduct(nativeProducts[0]);
        return {
            customerInfo: this.transformCustomerInfo(result.customerInfo)
        };
    }

    async syncPurchases(): Promise<void> {
        await Purchases.syncPurchases();
    }

    setLogLevel(level: LogLevel): void {
        const nativeLevel = logLevelMap[level];
        if (nativeLevel !== undefined) {
            Purchases.setLogLevel(nativeLevel);
        }
    }

    async presentPaywall(options?: PaywallOptions): Promise<PaywallResult> {
        try {
            // If offering is provided, we need to get the native offering object
            let nativeOffering = undefined;
            if (options?.offering) {
                // Get all native offerings and find the matching one
                const nativeOfferings = await Purchases.getOfferings();
                nativeOffering = nativeOfferings.all[options.offering.identifier];
            }
            
            const nativeResult = await RevenueCatUI.presentPaywall(nativeOffering ? {
                offering: nativeOffering
            } : undefined);
            
            // Map native paywall result to our enum
            switch (nativeResult) {
                case PAYWALL_RESULT.NOT_PRESENTED:
                    return PaywallResult.NOT_PRESENTED;
                case PAYWALL_RESULT.ERROR:
                    return PaywallResult.ERROR;
                case PAYWALL_RESULT.CANCELLED:
                    return PaywallResult.CANCELLED;
                case PAYWALL_RESULT.PURCHASED:
                    return PaywallResult.PURCHASED;
                case PAYWALL_RESULT.RESTORED:
                    return PaywallResult.RESTORED;
                default:
                    return PaywallResult.ERROR;
            }
        } catch (error) {
            console.error('Error presenting paywall:', error);
            return PaywallResult.ERROR;
        }
    }

    async presentPaywallIfNeeded(options?: PaywallOptions & { requiredEntitlementIdentifier: string }): Promise<PaywallResult> {
        try {
            // If offering is provided, we need to get the native offering object
            let nativeOffering = undefined;
            if (options?.offering) {
                // Get all native offerings and find the matching one
                const nativeOfferings = await Purchases.getOfferings();
                nativeOffering = nativeOfferings.all[options.offering.identifier];
            }
            
            const nativeResult = await RevenueCatUI.presentPaywallIfNeeded({
                offering: nativeOffering,
                requiredEntitlementIdentifier: options?.requiredEntitlementIdentifier || 'pro'
            });
            
            // Map native paywall result to our enum
            switch (nativeResult) {
                case PAYWALL_RESULT.NOT_PRESENTED:
                    return PaywallResult.NOT_PRESENTED;
                case PAYWALL_RESULT.ERROR:
                    return PaywallResult.ERROR;
                case PAYWALL_RESULT.CANCELLED:
                    return PaywallResult.CANCELLED;
                case PAYWALL_RESULT.PURCHASED:
                    return PaywallResult.PURCHASED;
                case PAYWALL_RESULT.RESTORED:
                    return PaywallResult.RESTORED;
                default:
                    return PaywallResult.ERROR;
            }
        } catch (error) {
            console.error('Error presenting paywall if needed:', error);
            return PaywallResult.ERROR;
        }
    }

    // Transform native types to our common types
    private transformCustomerInfo(native: NativeCustomerInfo): CustomerInfo {
        return {
            activeSubscriptions: native.activeSubscriptions || {},
            entitlements: {
                all: Object.entries(native.entitlements.all || {}).reduce((acc, [key, entitlement]) => {
                    acc[key] = {
                        isActive: entitlement.isActive,
                        identifier: entitlement.identifier
                    };
                    return acc;
                }, {} as Record<string, { isActive: boolean; identifier: string }>)
            },
            originalAppUserId: native.originalAppUserId,
            requestDate: new Date(native.requestDate)
        };
    }

    private transformProduct(native: PurchasesStoreProduct): Product {
        return {
            identifier: native.identifier,
            priceString: native.priceString,
            price: native.price,
            currencyCode: native.currencyCode,
            title: native.title,
            description: native.description
        };
    }

    private transformOfferings(native: PurchasesOfferings): Offerings {
        const transformPackages = (packages: any[]) => {
            return packages.map(pkg => ({
                identifier: pkg.identifier,
                packageType: pkg.packageType,
                product: this.transformProduct(pkg.storeProduct)
            }));
        };

        return {
            current: native.current ? {
                identifier: native.current.identifier,
                availablePackages: transformPackages(Object.values(native.current.availablePackages))
            } : null,
            all: Object.entries(native.all || {}).reduce((acc, [key, offering]) => {
                acc[key] = {
                    identifier: offering.identifier,
                    availablePackages: transformPackages(Object.values(offering.availablePackages))
                };
                return acc;
            }, {} as Record<string, any>)
        };
    }
}

export default new RevenueCatNative();