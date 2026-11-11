#if canImport(StoreKit)
import Foundation
import StoreKit

/// The App Store through StoreKit 2, the system framework: no purchase SDK.
/// Only what StoreKit verified ever leaves here; an unverified transaction
/// is never posted or finished.
public struct StoreKitSubscriptionStore: SubscriptionStore {
    /// The transactions handed out, kept so each can be finished.
    private let held = Held()

    public init() {}

    public func product(_ id: String) async -> StoreLookup {
        do {
            guard let product = try await Product.products(for: [id]).first else { return .missing }
            return Self.monthly(product).map(StoreLookup.found) ?? .missing
        } catch {
            return .unreached
        }
    }

    /// Sold only as a monthly auto-renewing subscription: never an annual
    /// or a four-week one as 2 hours a month.
    static func monthly(_ product: Product) -> StoreProduct? {
        guard product.type == .autoRenewable, let period = product.subscription?.subscriptionPeriod,
              period.value == 1, period.unit == .month else { return nil }
        return StoreProduct(id: product.id, displayPrice: product.displayPrice)
    }

    public func purchase(_ id: String, token: UUID) async -> StorePurchase {
        guard let product = try? await Product.products(for: [id]).first, Self.monthly(product) != nil else { return .failed }
        do {
            switch try await product.purchase(options: [.appAccountToken(token)]) {
            case .success(let result): return await take(result).map(StorePurchase.purchased) ?? .failed
            case .pending: return .pending
            case .userCancelled: return .cancelled
            @unknown default: return .failed
            }
        } catch StoreKitError.userCancelled {
            return .cancelled
        } catch {
            return .failed
        }
    }

    public func unfinished() async -> [StoreTransaction] {
        var found: [StoreTransaction] = []
        for await result in Transaction.unfinished {
            if let transaction = await take(result) { found.append(transaction) }
        }
        return found
    }

    public func entitlements() async -> [StoreTransaction] {
        var found: [StoreTransaction] = []
        for await result in Transaction.currentEntitlements {
            if let transaction = await take(result) { found.append(transaction) }
        }
        return found
    }

    public func sync() async -> Bool {
        do {
            try await AppStore.sync()
            return true
        } catch {
            return false
        }
    }

    public func appTransaction() async -> String? {
        try? await AppTransaction.shared.jwsRepresentation
    }

    public func finish(_ transaction: StoreTransaction) async {
        if let held = await held.take(transaction.id) { return await held.finish() }
        for await result in Transaction.unfinished {
            if case .verified(let unfinished) = result, String(unfinished.id) == transaction.id { await unfinished.finish() }
        }
    }

    public func updates() -> AsyncStream<StoreTransaction> {
        AsyncStream { continuation in
            let task = Task {
                for await result in Transaction.updates {
                    if let transaction = await take(result) { continuation.yield(transaction) }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func take(_ result: VerificationResult<Transaction>) async -> StoreTransaction? {
        guard case .verified(let transaction) = result else { return nil }
        await held.keep(transaction)
        return StoreTransaction(id: String(transaction.id), originalID: String(transaction.originalID), productID: transaction.productID,
                                jws: result.jwsRepresentation, token: transaction.appAccountToken)
    }

    private actor Held {
        private var transactions: [String: Transaction] = [:]

        func keep(_ transaction: Transaction) { transactions[String(transaction.id)] = transaction }

        func take(_ id: String) -> Transaction? { transactions.removeValue(forKey: id) }
    }
}
#endif
