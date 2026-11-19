#if canImport(UIKit)
import Foundation
import HappyAnalytics
@testable import HappyCore
import HappyWire
import StoreKit
import StoreKitTest
import XCTest

/// Subscribe through StoreKit itself (`StoreKitSubscriptionStore`), against
/// a local StoreKit configuration (`Fixtures/HappyPro.storekit`, its own
/// test product id), with RevenueCat faked: what a purchase comes to, and
/// the `paywall_error` code each ending sends. Only nothing on sale is
/// `store_unavailable`.
@MainActor
final class HostedStoreKitPurchaseTests: XCTestCase {
    private static let product = "happy.test.pro.monthly"
    private var session: SKTestSession?

    override func setUp() async throws {
        try await super.setUp()
        // On the iOS 27 simulators StoreKit testing sends `purchase(options:)`,
        // the call without a scene, to the sandbox, which asks for an Apple
        // Account and never answers; `purchase(confirmIn:)` stays local there.
        try XCTSkipIf(ProcessInfo.processInfo.isOperatingSystemAtLeast(OperatingSystemVersion(majorVersion: 27, minorVersion: 0, patchVersion: 0)),
                      "StoreKit testing sends a scene-less purchase to the sandbox on iOS 27")
        let bundle = Bundle(for: Self.self)
        let url = try XCTUnwrap(bundle.url(forResource: "HappyPro", withExtension: "storekit") ?? bundle.url(forResource: "HappyPro", withExtension: "storekit", subdirectory: "Fixtures"),
                                "HappyPro.storekit is not in the test bundle")
        let session = try SKTestSession(contentsOf: url)
        session.resetToDefaultState()
        session.disableDialogs = true
        session.clearTransactions()
        self.session = session
        // Empty unless the test host is installed for development: signed
        // with get-task-allow, as Xcode's own signing does.
        let products = try await Product.products(for: [Self.product])
        XCTAssertEqual(products.map(\.id), [Self.product], "the StoreKit configuration isn't the test host's")
    }

    override func tearDown() async throws {
        if let session {
            try await session.setSimulatedError(nil, forAPI: .purchase)
            try await session.setSimulatedError(nil, forAPI: .loadProducts)
            session.clearTransactions()
        }
        session = nil
        try await super.tearDown()
    }

    /// An owner over StoreKit, on sale once refreshed.
    private func ready(_ store: any SubscriptionStore) async -> Subscription {
        let defaults = InMemoryKeyValueStore()
        defaults.set("1", forKey: "subscription.migrated")
        let subscription = Subscription(store: store, revenueCat: StoreKitRevenueCat(product: Self.product), defaults: defaults)
        subscription.refresh()
        await subscription.idle()
        return subscription
    }

    private func code(_ result: Subscription.PurchaseResult) -> JSONValue? {
        result.event.properties["error_code"]
    }

    func testTheConfiguredMonthlyProductIsOnSaleAndBuys() async throws {
        let subscription = await ready(StoreKitSubscriptionStore())
        XCTAssertEqual(subscription.offer, .onSale(price: "$19.99"))
        let result = await subscription.buy()
        XCTAssertEqual(result.event, .paywallPurchased(product: .pro))
    }

    /// The second tap while StoreKit is still buying the first: before, it
    /// was sent as `store_unavailable` though the product was on sale.
    func testASecondSubscribeWhileStoreKitIsBuyingIsInProgress() async throws {
        let store = WatchedStore()
        let subscription = await ready(store)
        XCTAssertEqual(subscription.offer, .onSale(price: "$19.99"))
        let first = Task { await subscription.buy() }
        for _ in 0..<500 where !store.started { try await Task.sleep(for: .milliseconds(2)) }
        XCTAssertTrue(store.started)
        XCTAssertFalse(store.ended, "StoreKit answered before the second tap")
        let second = await subscription.buy()
        XCTAssertFalse(store.ended, "the second tap waited for the first")
        XCTAssertEqual(subscription.offer, .onSale(price: "$19.99"))
        XCTAssertEqual(code(second), .string("purchase_in_progress"))
        let bought = await first.value
        XCTAssertEqual(bought.event, .paywallPurchased(product: .pro))
        XCTAssertEqual(store.purchases, 1)
    }

    /// StoreKit's refusals keep their reason; before, each was `unknown`.
    /// (A simulated offer error comes back as StoreKit's own `unknown`, so
    /// `payment_invalid` is the unit tests'.)
    func testStoreKitRefusalsSayWhy() async throws {
        let subscription = await ready(StoreKitSubscriptionStore())
        let cases: [(SKTestFailures.Purchase, String)] = [
            (.generic(.networkError(URLError(.notConnectedToInternet))), "network"),
            (.purchase(.purchaseNotAllowed), "not_allowed"),
            (.purchase(.productUnavailable), "store_unavailable"),
            (.generic(.notAvailableInStorefront), "store_unavailable"),
            (.generic(.unknown), "unknown"),
        ]
        for (failure, expected) in cases {
            try await XCTUnwrap(session).setSimulatedError(failure, forAPI: .purchase)
            let result = await subscription.buy()
            XCTAssertEqual(code(result), .string(expected), "\(failure)")
            XCTAssertEqual(subscription.offer, .onSale(price: "$19.99"))
        }
    }

    /// The product asked for again as the sheet opens, offline: `network`, not `unknown`.
    func testTheProductUnreachableAtSubscribeIsNetwork() async throws {
        let subscription = await ready(StoreKitSubscriptionStore())
        XCTAssertEqual(subscription.offer, .onSale(price: "$19.99"))
        try await XCTUnwrap(session).setSimulatedError(.generic(.networkError(URLError(.notConnectedToInternet))), forAPI: .loadProducts)
        let result = await subscription.buy()
        XCTAssertEqual(code(result), .string("network"))
    }
}

/// StoreKit, with when its purchase started and ended.
private final class WatchedStore: SubscriptionStore, @unchecked Sendable {
    private let store = StoreKitSubscriptionStore()
    private let lock = NSLock()
    private var state = (started: false, ended: false, purchases: 0)

    var started: Bool { lock.withLock { state.started } }
    var ended: Bool { lock.withLock { state.ended } }
    var purchases: Int { lock.withLock { state.purchases } }

    func product(_ id: String) async -> StoreLookup { await store.product(id) }

    func purchase(_ id: String, token: UUID) async -> StorePurchase {
        lock.withLock {
            state.started = true
            state.purchases += 1
        }
        let result = await store.purchase(id, token: token)
        lock.withLock { state.ended = true }
        return result
    }

    func unfinished() async -> [StoreTransaction] { await store.unfinished() }
    func entitlements() async -> [StoreTransaction] { await store.entitlements() }
    func sync() async -> Bool { await store.sync() }
    func appTransaction() async -> String? { await store.appTransaction() }
    func finish(_ transaction: StoreTransaction) async { await store.finish(transaction) }
    func updates() -> AsyncStream<StoreTransaction> { store.updates() }
}

/// RevenueCat with one monthly package of `product`, taking every receipt.
private struct StoreKitRevenueCat: RevenueCatAPI {
    let product: String

    func offerings(customer: String) async -> RevenueCatAnswer {
        .ok(.object([
            "current_offering_id": .string("default"),
            "offerings": .array([.object([
                "identifier": .string("default"),
                "packages": .array([.object(["identifier": .string("$rc_monthly"), "platform_product_identifier": .string(product)])]),
            ])]),
        ]))
    }

    func subscriber(customer: String) async -> RevenueCatAnswer {
        .ok(.object(["subscriber": .object(["entitlements": .object([:]), "subscriptions": .object([:])])]))
    }

    func post(_ receipt: RevenueCatReceipt) async -> RevenueCatAnswer {
        await subscriber(customer: receipt.customer)
    }
}
#endif
