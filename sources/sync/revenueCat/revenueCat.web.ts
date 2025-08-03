import { Purchases } from '@revenuecat/purchases-js';
import { 
    RevenueCatInterface, 
    CustomerInfo, 
    Product, 
    Offerings, 
    PurchaseResult,
    RevenueCatConfig,
    LogLevel 
} from './types';

class RevenueCatWeb implements RevenueCatInterface {
    private purchases: Purchases | null = null;

    configure(config: RevenueCatConfig) {
        // Web SDK uses a different initialization pattern
        this.purchases = Purchases.configure({
            apiKey: config.apiKey,
            appUserId: config.appUserID
        });
        
        // Web SDK doesn't have the same async configuration
        // It's initialized synchronously
    }

    async getCustomerInfo(): Promise<CustomerInfo> {
        if (!this.purchases) {
            throw new Error('RevenueCat not configured');
        }

        const customerInfo = await this.purchases.getCustomerInfo();
        return this.transformCustomerInfo(customerInfo);
    }

    async getOfferings(): Promise<Offerings> {
        if (!this.purchases) {
            throw new Error('RevenueCat not configured');
        }

        const offerings = await this.purchases.getOfferings();
        return this.transformOfferings(offerings);
    }

    async getProducts(productIds: string[]): Promise<Product[]> {
        if (!this.purchases) {
            throw new Error('RevenueCat not configured');
        }

        // Web SDK doesn't have a direct getProducts method
        // Products are retrieved through offerings
        const offerings = await this.purchases.getOfferings();
        const products: Product[] = [];

        // Search through all offerings for the requested products
        Object.values(offerings.all || {}).forEach(offering => {
            offering.availablePackages.forEach(pkg => {
                if (productIds.includes(pkg.rcBillingProduct.identifier)) {
                    products.push(this.transformProduct(pkg.rcBillingProduct));
                }
            });
        });

        return products;
    }

    async purchaseStoreProduct(product: Product): Promise<PurchaseResult> {
        if (!this.purchases) {
            throw new Error('RevenueCat not configured');
        }

        // Web purchases work differently - they require a package, not just a product
        // Find the package that contains this product
        const offerings = await this.purchases.getOfferings();
        let targetPackage: any = null;

        Object.values(offerings.all || {}).forEach(offering => {
            offering.availablePackages.forEach(pkg => {
                if (pkg.rcBillingProduct.identifier === product.identifier) {
                    targetPackage = pkg;
                }
            });
        });

        if (!targetPackage) {
            throw new Error(`Package for product ${product.identifier} not found`);
        }

        const result = await this.purchases.purchasePackage(targetPackage);
        return {
            customerInfo: this.transformCustomerInfo(result.customerInfo)
        };
    }

    async syncPurchases(): Promise<void> {
        // Web SDK doesn't have a syncPurchases method
        // Customer info is always synced when retrieved
        if (!this.purchases) {
            throw new Error('RevenueCat not configured');
        }
        
        // Just fetch customer info to ensure sync
        await this.getCustomerInfo();
    }

    setLogLevel(level: LogLevel): void {
        // Web SDK doesn't support log levels
        // This is a no-op on web
        console.log(`RevenueCat log level set to ${LogLevel[level]} (not supported on web)`);
    }

    // Transform web types to our common types
    private transformCustomerInfo(webInfo: any): CustomerInfo {
        // Transform active subscriptions
        const activeSubscriptions: Record<string, any> = {};
        Object.entries(webInfo.subscriber.subscriptions || {}).forEach(([key, sub]: [string, any]) => {
            if (sub.isActive) {
                activeSubscriptions[key] = sub;
            }
        });

        // Transform entitlements
        const entitlements: Record<string, { isActive: boolean; identifier: string }> = {};
        Object.entries(webInfo.subscriber.entitlements || {}).forEach(([key, ent]: [string, any]) => {
            entitlements[key] = {
                isActive: ent.isActive,
                identifier: key
            };
        });

        return {
            activeSubscriptions,
            entitlements: { all: entitlements },
            originalAppUserId: webInfo.subscriber.originalAppUserId,
            requestDate: new Date()
        };
    }

    private transformProduct(webProduct: any): Product {
        return {
            identifier: webProduct.identifier,
            priceString: webProduct.priceString,
            price: webProduct.price,
            currencyCode: webProduct.currency,
            title: webProduct.displayName,
            description: webProduct.description || ''
        };
    }

    private transformOfferings(webOfferings: any): Offerings {
        const transformPackages = (packages: any[]) => {
            return packages.map(pkg => ({
                identifier: pkg.identifier,
                packageType: pkg.packageType || 'custom',
                product: this.transformProduct(pkg.rcBillingProduct)
            }));
        };

        return {
            current: webOfferings.current ? {
                identifier: webOfferings.current.identifier,
                availablePackages: transformPackages(webOfferings.current.availablePackages)
            } : null,
            all: Object.entries(webOfferings.all || {}).reduce((acc, [key, offering]: [string, any]) => {
                acc[key] = {
                    identifier: offering.identifier,
                    availablePackages: transformPackages(offering.availablePackages)
                };
                return acc;
            }, {} as Record<string, any>)
        };
    }
}

export default new RevenueCatWeb();