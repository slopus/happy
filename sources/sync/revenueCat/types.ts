// Common types that work across both native and web platforms

export interface CustomerInfo {
    activeSubscriptions: Record<string, any>;
    entitlements: {
        all: Record<string, {
            isActive: boolean;
            identifier: string;
        }>;
    };
    originalAppUserId: string;
    requestDate: Date;
}

export interface Product {
    identifier: string;
    priceString: string;
    price: number;
    currencyCode: string;
    title: string;
    description: string;
}

export interface Package {
    identifier: string;
    packageType: string;
    product: Product;
}

export interface Offering {
    identifier: string;
    availablePackages: Package[];
}

export interface Offerings {
    current: Offering | null;
    all: Record<string, Offering>;
}

export interface PurchaseResult {
    customerInfo: CustomerInfo;
}

export interface RevenueCatConfig {
    apiKey: string;
    appUserID: string;
    useAmazon?: boolean;
}

export enum LogLevel {
    VERBOSE = 0,
    DEBUG = 1,
    INFO = 2,
    WARN = 3,
    ERROR = 4
}

export enum PaywallResult {
    NOT_PRESENTED = 'NOT_PRESENTED',
    ERROR = 'ERROR',
    CANCELLED = 'CANCELLED',
    PURCHASED = 'PURCHASED',
    RESTORED = 'RESTORED'
}

export interface PaywallOptions {
    offering?: Offering;
}

// Main interface that all platform implementations must follow
export interface RevenueCatInterface {
    configure(config: RevenueCatConfig): void;
    getCustomerInfo(): Promise<CustomerInfo>;
    getOfferings(): Promise<Offerings>;
    getProducts(productIds: string[]): Promise<Product[]>;
    purchaseStoreProduct(product: Product): Promise<PurchaseResult>;
    syncPurchases(): Promise<void>;
    setLogLevel(level: LogLevel): void;
    presentPaywall(options?: PaywallOptions): Promise<PaywallResult>;
    presentPaywallIfNeeded(options?: PaywallOptions & { requiredEntitlementIdentifier: string }): Promise<PaywallResult>;
}