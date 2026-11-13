import Foundation
import HappyWire

/// Happy's push relay's capability for this install
/// (`HappyPushToken[<22 base62>]`): what a Happy Cloud server sends to.
/// Never printed.
public struct HappyPushToken: Equatable, Sendable, CustomStringConvertible {
    public let value: String

    public static func parse(_ value: String) -> HappyPushToken? {
        guard value.hasPrefix("HappyPushToken["), value.hasSuffix("]") else { return nil }
        let id = value.dropFirst("HappyPushToken[".count).dropLast()
        guard id.count == 22, id.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) else { return nil }
        return HappyPushToken(value: value)
    }

    public var description: String { "HappyPushToken(…)" }
}

/// A push request that failed. It keeps no body or token: an answer may
/// echo what was sent.
public struct CloudPushError: Error, Equatable, Sendable {
    public var status: Int?
}

/// What this install tells the relay and the server about itself.
public struct CloudPushDevice: Equatable, Sendable {
    /// The app ids the relay and Happy Cloud take; another build doesn't register.
    public static let appIds: Set<String> = ["com.ex3ndr.happy", "com.slopus.happy.preview", "com.slopus.happy.dev"]

    public var appId: String
    /// `aps-environment` is development (the APNs sandbox).
    public var development: Bool
    public var locale: String?

    public init(appId: String, development: Bool, locale: String? = nil) {
        self.appId = appId
        self.development = development
        self.locale = locale
    }
}

/// Happy's push relay (happy-push-server): this install's APNs token for
/// its `HappyPushToken`, stable per install whatever the APNs token.
public enum HappyPushRelay {
    public static let url = URL(string: "https://push.cluster-fluster.com/v1/devices/register")!

    /// `deviceId` is the install's private random UUID (`CloudPushIDs.device`).
    public static func exchange(apns token: Data, deviceId: String, device: CloudPushDevice, transport: any HTTPTransport) async throws -> HappyPushToken {
        var body: [String: JSONValue] = [
            "deviceId": .string(deviceId.lowercased()),
            "appId": .string(device.appId),
            "platform": .string("ios"),
            "provider": .string("apns"),
            "pushToken": .string(token.map { String(format: "%02x", $0) }.joined()),
            "environment": .string(device.development ? "development" : "production"),
        ]
        if let locale = device.locale { body["metadata"] = .object(["locale": .string(locale)]) }
        let request = HTTPRequest(method: "POST", url: url, headers: ["content-type": "application/json"], body: try JSONValue.object(body).encoded())
        let response: HTTPResponse
        do { response = try await transport.send(request) } catch { throw CloudPushError() }
        guard response.status == 200, response.body.count <= 8192,
              let value = (try? JSONValue.decode(response.body))?["token"]?.stringValue,
              let token = HappyPushToken.parse(value) else { throw CloudPushError(status: response.status) }
        return token
    }
}

/// A Happy Cloud server's record of this install (`PUT
/// /v0/cloud/push/registrations/:id`), kept until `expiresAt`.
public struct CloudPushRegistration: Decodable, Equatable, Sendable {
    public var id: String
    public var version: String
    public var expiresAt: Int64
}

public extension AgentClient {
    /// Registers this install's push token for the signed-in member under
    /// `id`, a lowercase UUID kept per server; again with the same id
    /// renews it.
    func registerCloudPush(_ id: String, token: HappyPushToken, device: CloudPushDevice) async throws -> CloudPushRegistration {
        struct Response: Decodable { var registration: CloudPushRegistration }
        var body: [String: JSONValue] = ["token": .string(token.value), "platform": .string("ios"), "appId": .string(device.appId)]
        if let locale = device.locale { body["locale"] = .string(locale) }
        do {
            return try await decode(Response.self, "PUT", "/v0/cloud/push/registrations/\(id)", json: .object(body)).registration
        } catch AgentClientError.status(let status, _, _) {
            throw CloudPushError(status: status)
        }
    }
}

/// This install's ids for cloud push, each a random lowercase UUID made
/// the first time and kept: the relay's `deviceId`, its own rather than
/// Expo's, and each server's registration id, so a renewal replaces
/// rather than adds.
public struct CloudPushIDs: Sendable {
    private let store: any KeyValueStore

    public init(store: any KeyValueStore) { self.store = store }

    public var device: String { id("cloudPush.device") }

    public func registration(for connection: String) -> String { id("cloudPush.registration.\(connection)") }

    private func id(_ key: String) -> String {
        if let id = store.string(forKey: key), UUID(uuidString: id)?.uuidString.lowercased() == id { return id }
        let id = UUID().uuidString.lowercased()
        store.set(id, forKey: key)
        return id
    }
}

/// Registers this install for push on Happy Cloud servers: the
/// notification permission, this install's APNs token, the relay's
/// `HappyPushToken` for it (asked again only when the APNs token
/// changes), then the server's registration. Onboarding's `mobileApp`
/// gate asks for the permission; coming back to a server renews quietly
/// where it was given, at most every few hours.
public actor CloudPush {
    public struct Source: Sendable {
        public var device: CloudPushDevice
        public var ids: CloudPushIDs
        public var transport: any HTTPTransport
        public var permission: @Sendable () async -> PushPermission
        public var requestPermission: @Sendable () async -> PushPermission
        public var apnsToken: @Sendable () async throws -> Data

        public init(device: CloudPushDevice, ids: CloudPushIDs, transport: any HTTPTransport,
                    permission: @escaping @Sendable () async -> PushPermission, requestPermission: @escaping @Sendable () async -> PushPermission,
                    apnsToken: @escaping @Sendable () async throws -> Data) {
            self.device = device
            self.ids = ids
            self.transport = transport
            self.permission = permission
            self.requestPermission = requestPermission
            self.apnsToken = apnsToken
        }
    }

    public enum Outcome: Equatable, Sendable {
        /// The server has this install now.
        case registered
        /// Renewed lately; nothing was sent.
        case current
        /// Notifications are off for the app.
        case denied
        /// A build the relay doesn't take (its app id).
        case unsupported
    }

    /// How long a renewal lasts before coming back renews again.
    public static let renewal: TimeInterval = 6 * 3600

    private let source: Source
    private var token: (apns: Data, happy: HappyPushToken)?
    private var renewed: [String: Date] = [:]

    public init(source: Source) { self.source = source }

    /// `ask`: from the person's tap, which may show the system prompt and
    /// always registers; else only where permission was given, and not
    /// again within `renewal`.
    public func register(connection: String, client: AgentClient, ask: Bool, now: Date = Date()) async throws -> Outcome {
        guard CloudPushDevice.appIds.contains(source.device.appId) else { return .unsupported }
        var permission = await source.permission()
        if ask, !permission.granted, permission.canAskAgain { permission = await source.requestPermission() }
        guard permission.granted else { return .denied }
        if !ask, let last = renewed[connection], now.timeIntervalSince(last) < Self.renewal { return .current }
        let apns = try await source.apnsToken()
        let happy: HappyPushToken
        if let token, token.apns == apns { happy = token.happy } else {
            happy = try await HappyPushRelay.exchange(apns: apns, deviceId: source.ids.device, device: source.device, transport: source.transport)
            token = (apns, happy)
        }
        _ = try await client.registerCloudPush(source.ids.registration(for: connection), token: happy, device: source.device)
        renewed[connection] = now
        return .registered
    }
}
