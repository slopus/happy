import * as z from 'zod';
import type { CustomerInfo } from './revenueCat/types';

//
// Schema
//

export const PurchasesSchema = z.object({
    activeSubscriptions: z.array(z.string()).describe('Active subscription product IDs'),
    entitlements: z.record(z.string(), z.boolean()).describe('Map of entitlement IDs to their active status'),
});

//
// NOTE: Purchases must be a flat object for forward/backward compatibility.
// The structure follows the same principles as settings:
// - Simple key-value pairs
// - No deep nesting
// - Preserved through schema changes
//

const PurchasesSchemaPartial = PurchasesSchema.loose().partial();

export type Purchases = z.infer<typeof PurchasesSchema>;

//
// Defaults
//

export const purchasesDefaults: Purchases = {
    activeSubscriptions: [],
    entitlements: {}
};
Object.freeze(purchasesDefaults);

//
// Resolving
//

export function purchasesParse(purchases: unknown): Purchases {
    const parsed = PurchasesSchemaPartial.safeParse(purchases);
    if (!parsed.success) {
        return { ...purchasesDefaults };
    }
    return { ...purchasesDefaults, ...parsed.data };
}

//
// Transform CustomerInfo to Purchases
//

export function customerInfoToPurchases(customerInfo: CustomerInfo): Purchases {
    // Extract active subscription product IDs
    // activeSubscriptions is a record of product ID to subscription info
    const activeSubscriptions = Object.keys(customerInfo.activeSubscriptions || {});

    // Extract entitlements (entitlement_id -> isActive)
    const entitlements: Record<string, boolean> = {};
    const allEntitlements = customerInfo.entitlements?.all || {};
    Object.entries(allEntitlements).forEach(([id, entitlement]) => {
        entitlements[id] = entitlement.isActive;
    });

    return {
        activeSubscriptions,
        entitlements
    };
}