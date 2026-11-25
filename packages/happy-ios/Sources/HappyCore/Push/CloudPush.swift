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

/// A server's record of this install (`PUT
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

    /// Takes this install's registration off the server; one already gone
    /// counts as taken off.
    func unregisterCloudPush(_ id: String, version: String) async throws {
        do { _ = try await send("DELETE", "/v0/cloud/push/registrations/\(id)", headers: ["If-Match": version]) }
        catch AgentClientError.status(404, _, _) {}
        catch AgentClientError.status(let status, _, _) { throw CloudPushError(status: status) }
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

    /// The version the server gave the registration, for taking it off.
    public func version(for connection: String) -> String? { store.string(forKey: "cloudPush.version.\(connection)") }

    public func registered(_ connection: String, version: String) { store.set(version, forKey: "cloudPush.version.\(connection)") }

    /// Taken off: the next registration on this server is a new one.
    public func forget(_ connection: String) {
        store.set(nil, forKey: "cloudPush.version.\(connection)")
        store.set(nil, forKey: "cloudPush.registration.\(connection)")
    }

    private func id(_ key: String) -> String {
        if let id = store.string(forKey: key), UUID(uuidString: id)?.uuidString.lowercased() == id { return id }
        let id = UUID().uuidString.lowercased()
        store.set(id, forKey: key)
        return id
    }
}

/// Registers this install for push on the servers that take it: the
/// notification permission, this install's APNs token, the relay's
/// `HappyPushToken` for it (asked again only when the APNs token
/// changes), then the server's registration. A Happy Cloud server always
/// takes it, and its onboarding's `mobileApp` gate asks for the
/// permission. Any other (a paired computer's Happy Agent daemon, a
/// team's own server) takes it when its health says
/// `capabilities.pushRegistrations`, with the same routes, and having no
/// onboarding, asks the first time it is reached. Coming back to a server
/// renews quietly where permission was given, at most every few hours;
/// leaving it takes the registration off (`unregister`).
///
/// Every server gets the same `HappyPushToken`, and the relay takes a
/// send from anyone who holds it. So a server registered with can send a
/// push that names another connection: what a push opens is decided here
/// (`CloudPushNotification.connection`), and only ever a chat that
/// connection already has.
public actor CloudPush {
    public struct Source: Sendable {
        public var device: CloudPushDevice
        public var ids: CloudPushIDs
        public var transport: any HTTPTransport
        public var permission: @Sendable () async -> PushPermission
        public var requestPermission: @Sendable () async -> PushPermission
        public var apnsToken: @Sendable () async throws -> Data
        /// Registrations still to be taken off computers since unpaired.
        public var leaving: any CloudPushUnregisterStore = InMemoryCloudPushUnregisterStore()
        /// A way to a computer by a pairing's credentials alone, for
        /// asking it again once the pairing's own is gone.
        public var connect: @Sendable (AgentConnectionCredentials) -> any AgentTransport = {
            AgentHTTPTransport(address: $0.address, port: $0.port, publicUrl: $0.publicUrl, tailcatAvailable: $0.tailcatAvailable != false)
        }

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
        /// A server that takes no registrations; it was asked nothing.
        case unserved
        /// A connection being left, or left: nothing registers on it again.
        case leaving
    }

    /// How long a renewal lasts before coming back renews again.
    public static let renewal: TimeInterval = 6 * 3600

    private let source: Source
    private var token: (apns: Data, happy: HappyPushToken)?
    private var renewed: [String: Date] = [:]
    /// The registration on its way for a connection. A server gives each
    /// one it takes a new version and takes off only the latest, so two
    /// sent at once could leave the phone holding the older: one is sent at
    /// a time, and leaving waits for it.
    private var registering: [String: (ask: Bool, task: Task<Outcome, Error>)] = [:]

    public init(source: Source) { self.source = source }

    /// `ask`: from the person's tap, which may show the system prompt and
    /// always registers; else not again within `renewal`. `cloud`: a
    /// Happy Cloud server, which is not asked what it serves and shows
    /// the prompt only from a tap. Any other is registered with only when
    /// its health says it takes registrations (an older daemon answers
    /// these routes 404, and is never asked), and shows the prompt while
    /// iOS still would, which is once.
    public func register(connection: String, client: AgentClient, ask: Bool, cloud: Bool, now: Date = Date()) async throws -> Outcome {
        // A connection that comes up says so more than once at the same
        // moment: the second is answered as the first is. A tap is never
        // answered by a quiet renewal, which may not have asked.
        while let running = registering[connection] {
            let result = await running.task.result
            if running.ask || !ask { return try result.get() }
        }
        let task = Task { try await send(connection: connection, client: client, ask: ask, cloud: cloud, now: now) }
        registering[connection] = (ask, task)
        defer { registering[connection] = nil }
        return try await task.value
    }

    private func send(connection: String, client: AgentClient, ask: Bool, cloud: Bool, now: Date) async throws -> Outcome {
        guard CloudPushDevice.appIds.contains(source.device.appId) else { return .unsupported }
        if !cloud, try await client.health().capabilities?.pushRegistrations != true { return .unserved }
        var permission = await source.permission()
        if ask || !cloud, !permission.granted, permission.canAskAgain { permission = await source.requestPermission() }
        guard permission.granted else { return .denied }
        if !ask, let last = renewed[connection], now.timeIntervalSince(last) < Self.renewal { return .current }
        let apns = try await source.apnsToken()
        let happy: HappyPushToken
        if let token, token.apns == apns { happy = token.happy } else {
            happy = try await HappyPushRelay.exchange(apns: apns, deviceId: source.ids.device, device: source.device, transport: source.transport)
            token = (apns, happy)
        }
        let registration = try await client.registerCloudPush(source.ids.registration(for: connection), token: happy, device: source.device)
        source.ids.registered(connection, version: registration.version)
        renewed[connection] = now
        return .registered
    }

    /// Signing out of a server, leaving it or unpairing its computer: its
    /// registration goes, so the phone stops getting its notifications
    /// now, not at the registration's expiry. Called before the session
    /// is revoked. One never registered with is sent nothing.
    public func unregister(connection: String, client: AgentClient, credentials: AgentConnectionCredentials? = nil) async throws {
        // One on its way lands first: its version is the one to take off.
        while let running = registering[connection] { _ = await running.task.result }
        renewed[connection] = nil
        guard let version = source.ids.version(for: connection) else { return }
        try await client.unregisterCloudPush(source.ids.registration(for: connection), version: version)
        source.ids.forget(connection)
    }

    /// How soon a computer that didn't answer is asked again.
    var backoff = Backoff(initial: .seconds(2), maximum: .seconds(300))
    func setBackoff(_ backoff: Backoff) { self.backoff = backoff }
    /// For tests: another way to the computers from here on.
    func setConnect(_ connect: @escaping @Sendable (AgentConnectionCredentials) -> any AgentTransport) {}

    /// Asks the computers an earlier launch could not tell.
    public func resume() {}

    /// Returns once no computer is still to be told, or `limit` has passed.
    public func waitUntilSettled(limit: Duration = .seconds(10)) async {}
}
