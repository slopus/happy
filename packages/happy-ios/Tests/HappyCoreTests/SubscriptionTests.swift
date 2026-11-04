import Foundation
import HappyWire
import XCTest
@testable import HappyCore

/// The one subscription owner (`Subscription`) with the App Store and
/// RevenueCat faked: whose a purchase is, when it is posted and finished,
/// identity across sign-in and sign-out, restore, and what is on sale.
@MainActor
final class SubscriptionTests: XCTestCase {
    private var clock = 1_793_000_000.0
    private let defaults = InMemoryKeyValueStore()
    private let store = FakeStore()
    private let revenueCat = FakeRevenueCat()

    private func owner() -> Subscription {
        Subscription(store: store, revenueCat: revenueCat, defaults: defaults, now: { [unowned self] in clock })
    }

    /// An owner told its customer (`subject`, or the install's), settled.
    private func ready(_ subject: String? = nil, launch: Bool = false) async -> Subscription {
        let subscription = owner()
        if launch { subscription.launch() }
        subscription.relay(subject)
        await subscription.idle()
        return subscription
    }

    private func assertEqual<T: Equatable>(_ value: T, _ expected: T, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(value, expected, file: file, line: line)
    }

    private func waitFor(_ condition: () -> Bool) async {
        for _ in 0..<500 where !condition() { try? await Task.sleep(for: .milliseconds(2)) }
    }

    private func transaction(_ id: String, token: UUID?, original: String? = nil) -> StoreTransaction {
        StoreTransaction(id: id, originalID: original ?? id, productID: "happy_monthly", jws: "jws.\(id)", token: token)
    }

    // MARK: On sale

    func testWithoutAKeyNothingIsSoldAndNothingIsAsked() async {
        let subscription = Subscription(store: nil, revenueCat: nil, defaults: defaults)
        subscription.relay(nil)
        await subscription.idle()
        XCTAssertEqual(subscription.offer, .unavailable)
        XCTAssertEqual(subscription.problem, .unconfigured)
        assertEqual(await subscription.buy(), .unavailable)
        XCTAssertNil(RevenueCatClient.key(""))
        XCTAssertNil(RevenueCatClient.key("$(HAPPY_REVENUE_CAT_APPLE_KEY)"))
        XCTAssertEqual(RevenueCatClient.key(" appl_x "), "appl_x")
    }

    func testTheCurrentMonthlyPackageIsOnSaleAtTheStoresPrice() async {
        let subscription = await ready()
        XCTAssertEqual(subscription.offer, .onSale(price: "$19.99"))
        XCTAssertNil(subscription.problem)
        // No monthly package, or the store doesn't sell it monthly: nothing.
        revenueCat.offerings = FakeRevenueCat.offerings(product: nil)
        subscription.refresh()
        await subscription.idle()
        XCTAssertEqual(subscription.offer, .unavailable)
        XCTAssertEqual(subscription.problem, .noProduct)
        revenueCat.offerings = FakeRevenueCat.offerings(product: "happy_yearly")
        subscription.refresh()
        await subscription.idle()
        XCTAssertEqual(subscription.problem, .noProduct)
    }

    func testAKeyRevenueCatRefusesIsSaidAndNotRetriedAtOnce() async {
        revenueCat.refuse = 401
        let subscription = await ready()
        XCTAssertEqual(subscription.offer, .unavailable)
        XCTAssertEqual(subscription.problem, .refused(status: 401))
        XCTAssertEqual(revenueCat.calls.filter { $0.hasPrefix("offerings") }.count, 1)
    }

    func testAnExistingProOfAnyProductSellsNothing() async {
        revenueCat.grant("a", product: "happy_lifetime", expires: nil, at: clock)
        let subscription = await ready("a")
        XCTAssertTrue(subscription.hasPro)
        XCTAssertEqual(subscription.offer, .subscribed)
        assertEqual(await subscription.buy(), .unavailable)
        XCTAssertTrue(store.purchases.isEmpty)
    }

    /// Relaunched offline with the same customer: what RevenueCat said
    /// within the day holds; a day later it is unknown and grants nothing.
    func testALaunchWithTheSameCustomerKeepsTheDaysAnswer() async {
        revenueCat.grant("a", expires: clock + 20 * 86_400, at: clock)
        _ = await ready("a")
        revenueCat.unreachable = true
        clock += 3600
        let again = await ready("a")
        XCTAssertTrue(again.hasPro)
        clock += 86_400
        XCTAssertFalse(again.hasPro)
    }

    // MARK: Buying

    func testAPurchaseIsPostedForItsBuyerAndFinishedOnlyOnceTaken() async throws {
        let subscription = await ready("a")
        store.next = .bought
        assertEqual(await subscription.buy(), .purchased)
        let bought = try XCTUnwrap(store.purchases.first)
        XCTAssertEqual(bought.token, subscription.token(for: "a"))
        XCTAssertEqual(revenueCat.posted.map(\.customer), ["a"])
        let receipt = try XCTUnwrap(revenueCat.posted.first)
        XCTAssertEqual(receipt.jws, "jws.\(bought.id)")
        XCTAssertEqual(receipt.source, .purchase)
        XCTAssertFalse(receipt.restore)
        XCTAssertEqual(receipt.appTransaction, "app.jws")
        XCTAssertEqual(store.finished, [bought.id])
        XCTAssertTrue(subscription.hasPro)
        XCTAssertEqual(subscription.offer, .subscribed)
    }

    func testAPurchaseRevenueCatDidntTakeStaysUnfinishedAndIsPostedAtTheNextForeground() async {
        let subscription = await ready("a")
        revenueCat.failPosts = 500
        store.next = .bought
        assertEqual(await subscription.buy(), .unconfirmed)
        XCTAssertTrue(store.finished.isEmpty)
        XCTAssertTrue(subscription.unconfirmed)
        XCTAssertEqual(subscription.offer, .unavailable)
        XCTAssertFalse(subscription.hasPro)
        revenueCat.failPosts = nil
        subscription.refresh()
        await subscription.idle()
        XCTAssertFalse(subscription.unconfirmed)
        XCTAssertEqual(revenueCat.posted.map(\.customer), ["a"])
        XCTAssertEqual(revenueCat.posted.last?.source, .queue)
        XCTAssertEqual(store.finished.count, 1)
        XCTAssertTrue(subscription.hasPro)
    }

    /// RevenueCat's SDK finishes on a 4xx; this keeps it for RevenueCat.
    func testARefusedReceiptIsNotFinished() async {
        let subscription = await ready("a")
        revenueCat.failPosts = 400
        store.next = .bought
        assertEqual(await subscription.buy(), .unconfirmed)
        XCTAssertTrue(store.finished.isEmpty)
        XCTAssertEqual(subscription.problem, .refused(status: 400))
    }

    func testASecondSubscribeWhileTheSheetIsOpenOpensNothing() async {
        let subscription = await ready("a")
        store.next = .held
        let first = Task { await subscription.buy() }
        await waitFor { store.open }
        assertEqual(await subscription.buy(), .unavailable)
        store.release(.cancelled)
        assertEqual(await first.value, .cancelled)
        XCTAssertEqual(store.purchases.count, 1)
    }

    func testCancelledAsAThenBoughtAsBIsBsAlone() async {
        let subscription = await ready("a")
        store.next = .cancel
        assertEqual(await subscription.buy(), .cancelled)
        subscription.relay("b")
        await subscription.idle()
        store.next = .bought
        assertEqual(await subscription.buy(), .purchased)
        XCTAssertEqual(revenueCat.posted.map(\.customer), ["b"])
        XCTAssertEqual(store.purchases.last?.token, Subscription.token("b"))
    }

    /// Ask to Buy for A; B signs in and buys; A's is approved months later:
    /// it is A's, and B is granted only B's.
    func testAPendingPurchaseIsItsBuyersHoweverLongItWaits() async {
        let subscription = await ready("a", launch: true)
        store.next = .pending
        assertEqual(await subscription.buy(), .pending)
        subscription.relay("b")
        await subscription.idle()
        store.next = .bought
        assertEqual(await subscription.buy(), .purchased)
        clock += 120 * 86_400
        let approved = transaction("late", token: Subscription.token("a"))
        store.deliver(approved)
        // Finished only once RevenueCat took it: after the post, so wait for the finish.
        await waitFor { store.finished.contains("late") }
        XCTAssertEqual(revenueCat.posted.map(\.customer), ["b", "a"])
        XCTAssertTrue(store.finished.contains("late"))
        XCTAssertEqual(subscription.customer, "b")
    }

    /// A bought, then signed out; B signs in. A renewal of A's arrives:
    /// posted for A, B granted nothing by it. The same after a restart,
    /// and delivered twice it is posted once.
    func testARenewalIsTheOriginalBuyersWhoeverIsSignedIn() async {
        var subscription = await ready("a", launch: true)
        store.next = .bought
        assertEqual(await subscription.buy(), .purchased)
        subscription.relay(nil)
        await subscription.idle()
        subscription.relay("b")
        await subscription.idle()
        let renewal = transaction("renewal1", token: Subscription.token("a"), original: store.purchases[0].id)
        store.deliver(renewal)
        await waitFor { revenueCat.posted.count == 2 }
        XCTAssertEqual(revenueCat.posted.last?.customer, "a")
        XCTAssertFalse(subscription.hasPro)
        // Restarted: the token is still A's.
        subscription = owner()
        subscription.launch()
        subscription.relay("b")
        await subscription.idle()
        let next = transaction("renewal2", token: Subscription.token("a"), original: store.purchases[0].id)
        store.deliver(next)
        store.deliver(next)
        await waitFor { store.finished.filter { $0 == "renewal2" }.count == 2 }
        XCTAssertEqual(revenueCat.posted.filter { $0.transactionID == "renewal2" }.map(\.customer), ["a"])
        XCTAssertFalse(subscription.hasPro)
    }

    /// Launch with transactions the store holds: the finished ones (already
    /// acknowledged) are never posted again; an unfinished one this install
    /// sold is posted for its owner; one it never sold is left for Restore.
    func testTheLaunchSweepPostsOnlyWhatItSoldAndLeftUnfinished() async {
        store.entitlementList = [transaction("old", token: nil)]
        store.unfinishedList = [transaction("mine", token: Subscription.token("a")), transaction("foreign", token: UUID())]
        let first = owner()
        _ = first.token(for: "a")
        let subscription = await ready(nil, launch: true)
        await waitFor { !store.finished.isEmpty }
        XCTAssertEqual(revenueCat.posted.map(\.transactionID), ["mine"])
        XCTAssertEqual(revenueCat.posted.map(\.customer), ["a"])
        XCTAssertEqual(store.finished, ["mine"])
        XCTAssertNotEqual(subscription.customer, "a")
    }

    // MARK: Restore

    func testRestorePostsWhatTheAccountHoldsForTheCustomerNow() async {
        let foreign = transaction("foreign", token: nil)
        store.entitlementList = [foreign]
        store.unfinishedList = [transaction("unknown", token: UUID())]
        let subscription = await ready("b")
        XCTAssertTrue(revenueCat.posted.isEmpty)
        revenueCat.grantOnPost = true
        assertEqual(await subscription.restore(), .restored)
        XCTAssertTrue(store.synced)
        XCTAssertEqual(Set(revenueCat.posted.map(\.transactionID)), ["foreign", "unknown"])
        XCTAssertTrue(revenueCat.posted.allSatisfy { $0.customer == "b" && $0.restore && $0.source == .restore })
        XCTAssertTrue(store.finished.contains("unknown"))
    }

    /// Restore needs the key and the store, never something on sale: an
    /// owned product that is no longer offered (a yearly one, here) is
    /// restored, and Subscribe stays off.
    func testRestoreWithNoMonthlyPackage() async {
        revenueCat.offerings = FakeRevenueCat.offerings(product: nil)
        await restoresWithNothingOnSale()
    }

    func testRestoreWithTheMonthlyProductMissingFromTheStore() async {
        store.productList = [:]
        await restoresWithNothingOnSale()
    }

    private func restoresWithNothingOnSale(file: StaticString = #filePath, line: UInt = #line) async {
        store.entitlementList = [StoreTransaction(id: "y1", originalID: "y0", productID: "happy_yearly", jws: "jws.y1", token: nil)]
        let subscription = await ready("b")
        XCTAssertEqual(subscription.offer, .unavailable, file: file, line: line)
        XCTAssertEqual(subscription.problem, .noProduct, file: file, line: line)
        assertEqual(await subscription.buy(), .unavailable, file: file, line: line)
        XCTAssertTrue(store.purchases.isEmpty, file: file, line: line)
        assertEqual(await subscription.restore(), .restored, file: file, line: line)
        XCTAssertEqual(revenueCat.posted.map(\.productID), ["happy_yearly"], file: file, line: line)
        XCTAssertTrue(revenueCat.posted.allSatisfy { $0.customer == "b" && $0.restore }, file: file, line: line)
        XCTAssertTrue(subscription.hasPro, file: file, line: line)
        XCTAssertEqual(subscription.offer, .subscribed, file: file, line: line)
    }

    func testRestoreWhilePendingFindsNothing() async {
        let subscription = await ready("a")
        store.next = .pending
        assertEqual(await subscription.buy(), .pending)
        assertEqual(await subscription.restore(), .nothingFound)
        XCTAssertTrue(revenueCat.posted.isEmpty)
        revenueCat.unreachable = true
        assertEqual(await subscription.restore(), .failed)
    }

    /// A bought; B restores it on purpose: the chain is B's from then on.
    /// Its next renewal, still carrying A's token, is posted for B and
    /// never back to A, after a restart too; another purchase of A's
    /// chain-apart stays A's.
    func testARestoredChainStaysWithWhoeverRestoredIt() async {
        var subscription = await ready("a", launch: true)
        store.next = .bought
        assertEqual(await subscription.buy(), .purchased)
        let original = store.purchases[0]
        store.entitlementList = [original]
        subscription.relay("b")
        await subscription.idle()
        revenueCat.grantOnPost = true
        assertEqual(await subscription.restore(), .restored)
        XCTAssertEqual(revenueCat.posted.last?.customer, "b")
        subscription = owner()
        subscription.launch()
        subscription.relay("b")
        await subscription.idle()
        store.deliver(transaction("renewal", token: Subscription.token("a"), original: original.id))
        store.deliver(transaction("other", token: Subscription.token("a"), original: "other-chain"))
        await waitFor { revenueCat.posted.count == 4 }
        XCTAssertEqual(revenueCat.posted.first { $0.transactionID == "renewal" }?.customer, "b")
        XCTAssertEqual(revenueCat.posted.first { $0.transactionID == "other" }?.customer, "a")
    }

    /// A restore whose customer changes before RevenueCat answers moves nothing.
    func testARestoreOvertakenByASwitchMovesNoChain() async {
        let chain = transaction("chain", token: Subscription.token("a"))
        store.entitlementList = [chain]
        let subscription = await ready("b")
        _ = subscription.token(for: "a")
        revenueCat.onPost = { [weak subscription] in Task { @MainActor in subscription?.relay("c") } }
        assertEqual(await subscription.restore(), .failed)
        revenueCat.onPost = nil
        await subscription.idle()
        subscription.launch()
        store.deliver(transaction("renewal", token: Subscription.token("a"), original: "chain"))
        await waitFor { revenueCat.posted.contains { $0.transactionID == "renewal" } }
        XCTAssertEqual(revenueCat.posted.first { $0.transactionID == "renewal" }?.customer, "a")
    }

    // MARK: Identity

    func testTheInstallsCustomerIsAnonymousAndKeptUntilSignOut() async {
        let subscription = await ready()
        let install = subscription.customer
        XCTAssertTrue(install.hasPrefix("$RCAnonymousID:"))
        XCTAssertEqual(install.count, "$RCAnonymousID:".count + 32)
        XCTAssertTrue(install.dropFirst("$RCAnonymousID:".count).allSatisfy { "0123456789abcdef".contains($0) })
        XCTAssertEqual(owner().customer, install)
    }

    func testSigningInAfterBuyingBringsTheInstallIntoTheAccountAndRetiresIt() async {
        let subscription = await ready()
        let install = subscription.customer
        store.next = .bought
        assertEqual(await subscription.buy(), .purchased)
        subscription.relay("a")
        await subscription.idle()
        XCTAssertEqual(revenueCat.identified.map { "\($0.0)>\($0.1)" }, ["\(install)>a"])
        XCTAssertEqual(subscription.customer, "a")
        subscription.relay(nil)
        await subscription.idle()
        XCTAssertNotEqual(subscription.customer, install)
        XCTAssertTrue(subscription.customer.hasPrefix("$RCAnonymousID:"))
        // The retired install's token is still its own, for its renewals.
        XCTAssertNotEqual(Subscription.token(subscription.customer), Subscription.token(install))
    }

    func testSigningInWithNothingBoughtJustSwitches() async {
        let subscription = await ready()
        subscription.relay("a")
        await subscription.idle()
        subscription.relay("b")
        await subscription.idle()
        XCTAssertTrue(revenueCat.identified.isEmpty)
        XCTAssertEqual(subscription.customer, "b")
    }

    /// identify unanswered: nothing is sold or granted under either, and it
    /// is asked again at the next foreground.
    func testAnUnansweredIdentifySellsNothingUntilItIsAnswered() async {
        let subscription = await ready()
        store.next = .bought
        _ = await subscription.buy()
        revenueCat.unreachable = true
        subscription.relay("a")
        await subscription.idle()
        XCTAssertEqual(subscription.offer, .unavailable)
        XCTAssertFalse(subscription.hasPro)
        XCTAssertEqual(subscription.problem, .unreached)
        revenueCat.unreachable = false
        subscription.refresh()
        await subscription.idle()
        XCTAssertEqual(subscription.customer, "a")
        XCTAssertEqual(revenueCat.identified.count, 1)
    }

    /// An answer asked for A that comes back after a switch to B grants B nothing.
    func testAnAnswerAskedBeforeASwitchIsDropped() async {
        revenueCat.grant("a", expires: clock + 20 * 86_400, at: clock)
        let subscription = owner()
        revenueCat.onSubscriber = { [weak subscription] customer in
            if customer == "a" { Task { @MainActor in subscription?.relay("b") } }
        }
        subscription.relay("a")
        await subscription.idle()
        await subscription.idle()
        XCTAssertEqual(subscription.customer, "b")
        XCTAssertFalse(subscription.hasPro)
        // Mid-change, nothing is on sale or granted.
        revenueCat.onSubscriber = nil
        subscription.relay("a")
        XCTAssertEqual(subscription.offer, .unavailable)
        XCTAssertFalse(subscription.hasPro)
        await subscription.idle()
        XCTAssertTrue(subscription.hasPro)
    }

    /// An agent connection in front keeps the account before it, while that
    /// account is signed in here.
    func testAnAgentConnectionKeepsTheAccountBeforeIt() async {
        let subscription = owner()
        subscription.accounts(active: .init(id: "x", subject: "a"), signedIn: ["x"])
        await subscription.idle()
        XCTAssertEqual(subscription.customer, "a")
        subscription.accounts(active: nil, signedIn: ["x", "agent"])
        await subscription.idle()
        XCTAssertEqual(subscription.customer, "a")
        // Relaunched straight into the agent connection.
        let relaunched = owner()
        relaunched.accounts(active: nil, signedIn: ["x"])
        await relaunched.idle()
        XCTAssertEqual(relaunched.customer, "a")
        relaunched.accounts(active: nil, signedIn: ["agent"])
        await relaunched.idle()
        XCTAssertTrue(relaunched.customer.hasPrefix("$RCAnonymousID:"))
    }

    func testTheTokenIsTheCustomersForGood() {
        XCTAssertEqual(Subscription.token("a"), Subscription.token("a"))
        XCTAssertNotEqual(Subscription.token("a"), Subscription.token("b"))
        let text = Subscription.token("$RCAnonymousID:0123456789abcdef0123456789abcdef").uuidString
        XCTAssertEqual(Array(text)[14], "5")
        XCTAssertTrue("89AB".contains(Array(text)[19]))
    }

    // MARK: The REST client

    func testTheClientSpeaksRevenueCatsV1() async throws {
        let http = FakeHTTP()
        http.onRaw("GET /v1/subscribers/$RCAnonymousID:abc/offerings", #"{"current_offering_id":"d","offerings":[]}"#)
        http.onRaw("POST /v1/receipts", #"{"request_date":"2026-11-04T10:00:00Z","subscriber":{"entitlements":{}}}"#)
        http.onRaw("POST /v1/subscribers/identify", #"{"message":"Invalid API key"}"#, status: 401)
        let client = RevenueCatClient(transport: http, key: "appl_test")
        guard case .ok = await client.offerings(customer: "$RCAnonymousID:abc") else { return XCTFail("offerings") }
        let request = try XCTUnwrap(http.requests.first)
        XCTAssertEqual(request.url.absoluteString, "https://api.revenuecat.com/v1/subscribers/%24RCAnonymousID%3Aabc/offerings")
        XCTAssertEqual(request.headers["Authorization"], "Bearer appl_test")
        XCTAssertEqual(request.headers["X-Platform"], "iOS")
        XCTAssertEqual(request.headers["X-StoreKit2-Enabled"], "true")
        XCTAssertEqual(request.headers["X-StoreKit-Version"], "2")
        let receipt = RevenueCatReceipt(customer: "a", jws: "j", productID: "p", transactionID: "7", appTransaction: "app", restore: true, source: .restore)
        guard case .ok = await client.post(receipt) else { return XCTFail("post") }
        let body = try JSONValue.decode(try XCTUnwrap(http.requests("POST /v1/receipts").first?.body))
        XCTAssertEqual(body, .object([
            "payload_version": .number(1), "app_user_id": .string("a"), "fetch_token": .string("j"), "product_id": .string("p"),
            "transaction_id": .string("7"), "is_restore": .bool(true), "observer_mode": .bool(false), "initiation_source": .string("restore"),
            "sdk_originated": .bool(false), "app_transaction": .string("app"),
        ]))
        assertEqual(await client.identify(from: "x", to: "y"), .refused(status: 401, message: "Invalid API key"))
    }
}

// MARK: Fakes

/// The App Store: what it sells, what each sheet comes to, and what it holds.
final class FakeStore: SubscriptionStore, @unchecked Sendable {
    enum Next { case bought, pending, cancel, held }

    private let lock = NSLock()
    private var state = State()
    private struct State {
        var next: Next = .bought
        var products = ["happy_monthly": StoreProduct(id: "happy_monthly", displayPrice: "$19.99")]
        var purchases: [StoreTransaction] = []
        var unfinished: [StoreTransaction] = []
        var entitlements: [StoreTransaction] = []
        var finished: [String] = []
        var synced = false
        var open = false
        var held: CheckedContinuation<StorePurchase, Never>?
        var continuation: AsyncStream<StoreTransaction>.Continuation?
    }

    private func with<T>(_ body: (inout State) -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body(&state)
    }

    var next: Next { get { with { $0.next } } set { with { $0.next = newValue } } }
    var purchases: [StoreTransaction] { with { $0.purchases } }
    var finished: [String] { with { $0.finished } }
    var synced: Bool { with { $0.synced } }
    var open: Bool { with { $0.open } }
    var unfinishedList: [StoreTransaction] { get { with { $0.unfinished } } set { with { $0.unfinished = newValue } } }
    var entitlementList: [StoreTransaction] { get { with { $0.entitlements } } set { with { $0.entitlements = newValue } } }
    var productList: [String: StoreProduct] { get { with { $0.products } } set { with { $0.products = newValue } } }

    func product(_ id: String) async -> StoreLookup {
        with { $0.products[id] }.map(StoreLookup.found) ?? .missing
    }

    func purchase(_ id: String, token: UUID) async -> StorePurchase {
        let (next, count) = with { state -> (Next, Int) in
            state.open = true
            return (state.next, state.purchases.count)
        }
        let transaction = StoreTransaction(id: "t\(count + 1)", originalID: "t\(count + 1)", productID: id, jws: "jws.t\(count + 1)", token: token)
        with { $0.purchases.append(transaction) }
        defer { with { $0.open = false } }
        switch next {
        case .bought:
            with { $0.unfinished.append(transaction) }
            return .purchased(transaction)
        case .pending: return .pending
        case .cancel: return .cancelled
        case .held: return await withCheckedContinuation { continuation in with { $0.held = continuation } }
        }
    }

    func release(_ result: StorePurchase) {
        with { state in
            state.held?.resume(returning: result)
            state.held = nil
        }
    }

    func unfinished() async -> [StoreTransaction] { with { $0.unfinished } }
    func entitlements() async -> [StoreTransaction] { with { $0.entitlements } }
    func sync() async -> Bool { with { $0.synced = true }; return true }
    func appTransaction() async -> String? { "app.jws" }

    func finish(_ transaction: StoreTransaction) async {
        with { state in
            state.finished.append(transaction.id)
            state.unfinished.removeAll { $0.id == transaction.id }
        }
    }

    func updates() -> AsyncStream<StoreTransaction> {
        AsyncStream { continuation in with { $0.continuation = continuation } }
    }

    /// The store tells the app of `transaction`, as `Transaction.updates` does.
    func deliver(_ transaction: StoreTransaction) {
        let continuation = with { state -> AsyncStream<StoreTransaction>.Continuation? in
            state.unfinished.append(transaction)
            return state.continuation
        }
        continuation?.yield(transaction)
    }
}

/// RevenueCat: who has `pro`, and every call it was asked.
final class FakeRevenueCat: RevenueCatAPI, @unchecked Sendable {
    private let lock = NSLock()
    private var _calls: [String] = []
    private var _posted: [RevenueCatReceipt] = []
    private var _identified: [(String, String)] = []
    private var _grants: [String: String] = [:]
    var offerings: JSONValue = FakeRevenueCat.offerings(product: "happy_monthly")
    var refuse: Int?
    var failPosts: Int?
    var unreachable = false
    /// A receipt taken grants `pro` to the customer it was posted for.
    var grantOnPost = true
    var onPost: (() -> Void)?
    var onSubscriber: ((String) -> Void)?
    var now: Double = 1_793_000_000

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    var calls: [String] { locked { _calls } }
    var posted: [RevenueCatReceipt] { locked { _posted } }
    var identified: [(String, String)] { locked { _identified } }

    static func offerings(product: String?) -> JSONValue {
        let packages: JSONValue = product.map { .array([.object(["identifier": .string("$rc_monthly"), "platform_product_identifier": .string($0)])]) } ?? .array([])
        return .object(["current_offering_id": .string("default"), "offerings": .array([.object(["identifier": .string("default"), "packages": packages])])])
    }

    /// `customer` has `pro` from `product` until `expires`, as of `at`.
    func grant(_ customer: String, product: String = "happy_monthly", expires: Double?, at: Double) {
        now = at
        let expiry = expires.map { Date(timeIntervalSince1970: $0).formatted(.iso8601) }.map { "\"\($0)\"" } ?? "null"
        let purchased = Date(timeIntervalSince1970: at - 86_400).formatted(.iso8601)
        locked { _grants[customer] = #""pro":{"expires_date":\#(expiry),"product_identifier":"\#(product)","purchase_date":"\#(purchased)"}"# }
    }

    private func answer(_ customer: String) -> RevenueCatAnswer {
        let entitlement = locked { _grants[customer] } ?? ""
        let at = Date(timeIntervalSince1970: now).formatted(.iso8601)
        return .ok(try! JSONValue.decode(Data(#"{"request_date":"\#(at)","subscriber":{"entitlements":{\#(entitlement)},"subscriptions":{}}}"#.utf8)))
    }

    func offerings(customer: String) async -> RevenueCatAnswer {
        locked { _calls.append("offerings \(customer)") }
        if unreachable { return .unreached }
        if let refuse { return .refused(status: refuse, message: nil) }
        return .ok(offerings)
    }

    func subscriber(customer: String) async -> RevenueCatAnswer {
        locked { _calls.append("subscriber \(customer)") }
        onSubscriber?(customer)
        if unreachable { return .unreached }
        if let refuse { return .refused(status: refuse, message: nil) }
        await Task.yield()
        return answer(customer)
    }

    func post(_ receipt: RevenueCatReceipt) async -> RevenueCatAnswer {
        locked { _calls.append("post \(receipt.customer)") }
        onPost?()
        await Task.yield()
        if unreachable { return .unreached }
        if let status = failPosts ?? refuse { return .refused(status: status, message: nil) }
        locked { _posted.append(receipt) }
        if grantOnPost { grant(receipt.customer, expires: now + 30 * 86_400, at: now) }
        return answer(receipt.customer)
    }

    func identify(from: String, to: String) async -> RevenueCatAnswer {
        locked { _calls.append("identify") }
        if unreachable { return .unreached }
        locked { _identified.append((from, to)) }
        return answer(to)
    }
}
