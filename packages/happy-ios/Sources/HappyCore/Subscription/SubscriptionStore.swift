import Foundation

/// The App Store as the subscription sees it: StoreKit 2 on Apple's
/// platforms (`StoreKitSubscriptionStore`), a fake in tests. Only verified
/// transactions ever come out of it.
public protocol SubscriptionStore: Sendable {
    /// `id` as the store sells it; `.missing` when it isn't, or isn't a
    /// monthly auto-renewing subscription.
    func product(_ id: String) async -> StoreLookup
    /// The store's purchase sheet for `id`, the purchase tagged with `token`
    /// (StoreKit's `appAccountToken`), which it keeps on every renewal.
    func purchase(_ id: String, token: UUID) async -> StorePurchase
    /// Verified transactions not finished yet: bought, renewed or approved
    /// while nothing here was listening, or posted but not finished.
    func unfinished() async -> [StoreTransaction]
    /// What the App Store account holds now (`Transaction.currentEntitlements`).
    func entitlements() async -> [StoreTransaction]
    /// Brings the store's transactions up to date with the App Store
    /// (`AppStore.sync`); may ask the person to sign in. Restore only.
    func sync() async -> Bool
    /// The app's own AppTransaction JWS, where the OS has one.
    func appTransaction() async -> String?
    func finish(_ transaction: StoreTransaction) async
    /// Verified transactions as the store delivers them while the app runs
    /// (`Transaction.updates`): renewals, Ask to Buy approvals, refunds,
    /// purchases made on another device.
    func updates() -> AsyncStream<StoreTransaction>
}

public struct StoreProduct: Equatable, Sendable {
    public var id: String
    /// The store's own localised price, "$19.99", "19,99 €".
    public var displayPrice: String

    public init(id: String, displayPrice: String) {
        self.id = id
        self.displayPrice = displayPrice
    }
}

public enum StoreLookup: Equatable, Sendable {
    case found(StoreProduct)
    case missing
    case unreached
}

/// A verified StoreKit 2 transaction, with what RevenueCat needs of it.
public struct StoreTransaction: Equatable, Sendable {
    public var id: String
    /// The first transaction of its chain: the same across renewals.
    public var originalID: String
    public var productID: String
    /// Its signed JWS, which RevenueCat verifies with Apple.
    public var jws: String
    /// The `appAccountToken` it was bought with; nil when bought elsewhere
    /// or by an app that set none.
    public var token: UUID?

    public init(id: String, originalID: String, productID: String, jws: String, token: UUID?) {
        self.id = id
        self.originalID = originalID
        self.productID = productID
        self.jws = jws
        self.token = token
    }
}

/// What the store's purchase sheet came to.
public enum StorePurchase: Equatable, Sendable {
    case purchased(StoreTransaction)
    /// Waiting on Ask to Buy or a payment problem: the transaction comes
    /// later through `updates`, with its token.
    case pending
    case cancelled
    /// The store refused, or what it returned didn't verify.
    case failed
}
