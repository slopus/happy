import Foundation
import HappyWire

/// What RevenueCat said to one request.
public enum RevenueCatAnswer: Equatable, Sendable {
    case ok(JSONValue)
    /// A 4xx is the request or the key, a 5xx RevenueCat; status 0 is an
    /// answer that isn't JSON. `message` is RevenueCat's, never shown raw.
    case refused(status: Int, message: String?)
    /// No answer: offline, timed out.
    case unreached
}

/// A StoreKit 2 transaction as `POST /v1/receipts` takes it, the fields
/// RevenueCat's SDK sends (`PostReceiptDataOperation.PostData`): the
/// transaction's JWS as `fetch_token`, the app's AppTransaction JWS when
/// there is one.
public struct RevenueCatReceipt: Equatable, Sendable {
    public enum Source: String, Sendable { case purchase, restore, queue }

    public var customer: String
    public var jws: String
    public var productID: String
    public var transactionID: String
    public var appTransaction: String?
    public var restore: Bool
    public var source: Source

    public init(customer: String, jws: String, productID: String, transactionID: String, appTransaction: String?, restore: Bool, source: Source) {
        self.customer = customer
        self.jws = jws
        self.productID = productID
        self.transactionID = transactionID
        self.appTransaction = appTransaction
        self.restore = restore
        self.source = source
    }
}

/// What the subscription asks of RevenueCat: apart, so it can be tested without it.
public protocol RevenueCatAPI: Sendable {
    func offerings(customer: String) async -> RevenueCatAnswer
    func subscriber(customer: String) async -> RevenueCatAnswer
    func post(_ receipt: RevenueCatReceipt) async -> RevenueCatAnswer
    /// The SDK's `logIn`: `from` (anonymous) brought into, or just switched to, `to`.
    func identify(from: String, to: String) async -> RevenueCatAnswer
}

/// RevenueCat's REST API v1 with the app's public Apple SDK key, the calls
/// its SDK makes (purchases-ios 5.102.0 `HTTPRequestPath`), without the SDK.
/// Never a secret key; a customer id, token or receipt is never logged.
public struct RevenueCatClient: RevenueCatAPI {
    private let transport: any HTTPTransport
    private let key: String
    private let base: URL

    public init(transport: any HTTPTransport, key: String, base: URL = URL(string: "https://api.revenuecat.com")!) {
        self.transport = transport
        self.key = key
        self.base = base
    }

    /// The build's key (`HappyRevenueCatAppleKey`, from `HAPPY_REVENUE_CAT_APPLE_KEY`);
    /// nil when it is empty or an unexpanded build setting.
    public static func key(_ value: Any?) -> String? {
        guard let text = (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !text.isEmpty, !text.hasPrefix("$(") else { return nil }
        return text
    }

    public func offerings(customer: String) async -> RevenueCatAnswer {
        await send("GET", "/v1/subscribers/\(Self.path(customer))/offerings")
    }

    public func subscriber(customer: String) async -> RevenueCatAnswer {
        await send("GET", "/v1/subscribers/\(Self.path(customer))")
    }

    public func post(_ receipt: RevenueCatReceipt) async -> RevenueCatAnswer {
        var body: [String: JSONValue] = [
            "payload_version": .number(1),
            "app_user_id": .string(receipt.customer),
            "fetch_token": .string(receipt.jws),
            "product_id": .string(receipt.productID),
            "transaction_id": .string(receipt.transactionID),
            "is_restore": .bool(receipt.restore),
            "observer_mode": .bool(false),
            "initiation_source": .string(receipt.source.rawValue),
            "sdk_originated": .bool(receipt.source == .purchase),
        ]
        if let appTransaction = receipt.appTransaction { body["app_transaction"] = .string(appTransaction) }
        return await send("POST", "/v1/receipts", body: body)
    }

    public func identify(from: String, to: String) async -> RevenueCatAnswer {
        await send("POST", "/v1/subscribers/identify", body: ["app_user_id": .string(from), "new_app_user_id": .string(to)])
    }

    private func send(_ method: String, _ path: String, body: [String: JSONValue]? = nil) async -> RevenueCatAnswer {
        guard let url = URL(string: base.absoluteString + path) else { return .refused(status: 0, message: nil) }
        let request = HTTPRequest(method: method, url: url, headers: [
            "Authorization": "Bearer \(key)",
            "X-Platform": "iOS",
            "X-StoreKit2-Enabled": "true",
            "X-StoreKit-Version": "2",
            "X-Observer-Mode-Enabled": "false",
            "Content-Type": "application/json",
        ], body: try? body.map { try JSONValue.object($0).encoded() })
        let response: HTTPResponse
        do { response = try await transport.send(request) } catch { return .unreached }
        let json = try? JSONValue.decode(response.body)
        guard (200..<300).contains(response.status) else { return .refused(status: response.status, message: json?["message"]?.stringValue) }
        return json.map(RevenueCatAnswer.ok) ?? .refused(status: 0, message: nil)
    }

    /// A customer id as one path segment: `$RCAnonymousID:…` and anything
    /// else outside the unreserved characters percent-encoded.
    static func path(_ customer: String) -> String {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        return customer.trimmingCharacters(in: .whitespacesAndNewlines).addingPercentEncoding(withAllowedCharacters: allowed) ?? customer
    }

    /// The current offering's monthly package (`$rc_monthly`), as the App
    /// Store knows it (`platform_product_identifier`); nil without one.
    public static func monthlyProduct(_ offerings: JSONValue) -> String? {
        guard let current = offerings["current_offering_id"]?.stringValue,
              let offering = offerings["offerings"]?.arrayValue?.first(where: { $0["identifier"]?.stringValue == current }),
              let package = offering["packages"]?.arrayValue?.first(where: { $0["identifier"]?.stringValue == "$rc_monthly" }),
              let product = package["platform_product_identifier"]?.stringValue,
              !product.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        return product
    }
}
