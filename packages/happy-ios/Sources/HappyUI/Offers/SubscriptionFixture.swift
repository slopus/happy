#if DEBUG && canImport(UIKit)
import Foundation
import HappyCore
import HappyWire

/// Debug test runs only (`HAPPY_SUBSCRIPTION_FIXTURE`): the real owner
/// (`Subscription`) over a store and a RevenueCat that live in memory, for
/// screenshots and hosted tests of every sheet and page. Nothing reaches
/// the App Store or RevenueCat, nothing is charged, and nothing is kept
/// past the run.
/// - `onsale`: the monthly subscription at `HAPPY_SUBSCRIPTION_PRICE`
///   (default "$19.99"); Subscribe buys at once, and RevenueCat grants pro.
/// - `subscribed`: this customer has pro already.
/// - `pending`: Subscribe waits on Ask to Buy.
/// - `unconfirmed`: bought, but RevenueCat can't be reached to take it.
/// - `unconfigured`: no key, nothing sold.
struct SubscriptionFixture {
    let subscription: Subscription

    @MainActor
    init?(_ name: String?) {
        guard let name else { return nil }
        let defaults = InMemoryKeyValueStore()
        let price = ProcessInfo.processInfo.environment["HAPPY_SUBSCRIPTION_PRICE"] ?? "$19.99"
        switch name {
        case "unconfigured":
            subscription = Subscription(store: nil, revenueCat: nil, defaults: defaults)
        case "onsale", "subscribed", "pending", "unconfirmed":
            let revenueCat = FixtureRevenueCat(everyone: name == "subscribed", reachable: name != "unconfirmed")
            subscription = Subscription(store: FixtureStore(price: price, pending: name == "pending"), revenueCat: revenueCat, defaults: defaults)
        default:
            return nil
        }
    }
}

private final class FixtureStore: SubscriptionStore, @unchecked Sendable {
    private let price: String
    private let pending: Bool
    private let lock = NSLock()
    private var bought: [StoreTransaction] = []

    init(price: String, pending: Bool) {
        self.price = price
        self.pending = pending
    }

    func product(_ id: String) async -> StoreLookup { .found(StoreProduct(id: id, displayPrice: price)) }

    func purchase(_ id: String, token: UUID) async -> StorePurchase {
        try? await Task.sleep(for: .milliseconds(600))
        if pending { return .pending }
        let transaction = StoreTransaction(id: UUID().uuidString, originalID: "fixture", productID: id, jws: "fixture", token: token)
        lock.withLock { bought.append(transaction) }
        return .purchased(transaction)
    }

    func unfinished() async -> [StoreTransaction] { lock.withLock { bought } }
    func entitlements() async -> [StoreTransaction] { lock.withLock { bought } }
    func sync() async -> Bool { true }
    func appTransaction() async -> String? { nil }
    func finish(_ transaction: StoreTransaction) async { lock.withLock { bought.removeAll { $0.id == transaction.id } } }
    func updates() -> AsyncStream<StoreTransaction> { AsyncStream { _ in } }
}

private final class FixtureRevenueCat: RevenueCatAPI, @unchecked Sendable {
    private let everyone: Bool
    private let reachable: Bool
    private let lock = NSLock()
    private var granted: Set<String> = []

    init(everyone: Bool, reachable: Bool) {
        self.everyone = everyone
        self.reachable = reachable
    }

    func offerings(customer: String) async -> RevenueCatAnswer {
        .ok(.object(["current_offering_id": .string("default"), "offerings": .array([.object([
            "identifier": .string("default"),
            "packages": .array([.object(["identifier": .string("$rc_monthly"), "platform_product_identifier": .string("happy_monthly")])]),
        ])])]))
    }

    func subscriber(customer: String) async -> RevenueCatAnswer { answer(customer) }

    func post(_ receipt: RevenueCatReceipt) async -> RevenueCatAnswer {
        guard reachable else { return .unreached }
        lock.withLock { _ = granted.insert(receipt.customer) }
        return answer(receipt.customer)
    }

    func identify(from: String, to: String) async -> RevenueCatAnswer { answer(to) }

    private func answer(_ customer: String) -> RevenueCatAnswer {
        let now = Date()
        let pro = everyone || lock.withLock { granted.contains(customer) }
        let entitlements: JSONValue = pro ? .object([ProPass.entitlement: .object([
            "expires_date": .string(now.addingTimeInterval(20 * 86_400).formatted(.iso8601)),
            "product_identifier": .string("happy_monthly"),
            "purchase_date": .string(now.addingTimeInterval(-10 * 86_400).formatted(.iso8601)),
        ])]) : .object([:])
        return .ok(.object(["request_date": .string(now.formatted(.iso8601)), "subscriber": .object(["entitlements": entitlements, "subscriptions": .object([:])])]))
    }
}
#endif
