// Main export that selects the correct implementation based on platform
// React Native's bundler will automatically choose .native.ts or .web.ts

// This will be resolved to either revenueCat.native.ts or revenueCat.web.ts
// based on the platform
export { default as RevenueCat } from "./revenueCat";
export {
	CustomerInfo,
	LogLevel,
	Offering,
	Offerings,
	Package,
	PaywallOptions,
	PaywallResult,
	Product,
	PurchaseResult,
	RevenueCatConfig,
	RevenueCatInterface,
} from "./types";
