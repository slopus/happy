import Foundation
import HappyWire

/// Expo's APNs registration exchange, after expo-notifications/getExpoPushTokenAsync.
/// Receives device identity and APNs environment from UIKit/Keychain composition.
public struct ExpoPushTokenExchange: PushTokenSource, Sendable {
    /// happy-app app.config.js extra.eas.projectId.
    public static let happyProjectId = "4558dd3d-cd5a-47cd-bad9-e591a241cc06"
    /// Expo notifications persists a UUID under this Keychain account key.
    public static let installationIdKey = "EXDeviceInstallationUUIDKey"

    /// Everything Expo needs to associate the token with this installation.
    public struct Configuration: Equatable, Sendable {
        /// Persistent installation UUID; lowercased on the wire as `deviceId`.
        public var deviceId: String
        /// `aps-environment == development`; never infer this from Debug configuration.
        public var development: Bool
        /// The running app's bundle identifier (`appId`).
        public var appId: String
        /// Expo EAS project id (`projectId`).
        public var projectId: String

        public init(deviceId: String, development: Bool, appId: String, projectId: String = ExpoPushTokenExchange.happyProjectId) {
            self.deviceId = deviceId
            self.development = development
            self.appId = appId
            self.projectId = projectId
        }
    }

    private let transport: any HTTPTransport
    private let configuration: Configuration
    private let deviceToken: @Sendable () async throws -> Data?

    /// Token callback supplies APNs bytes, not an already formatted Expo token.
    public init(transport: any HTTPTransport, configuration: Configuration, deviceToken: @escaping @Sendable () async throws -> Data?) {
        self.transport = transport
        self.configuration = configuration
        self.deviceToken = deviceToken
    }

    /// Ports getExpoPushTokenAsync: lowercases deviceId, sends APNs hex, reads data.expoPushToken.
    public func token() async throws -> String? {
        guard let token = try await deviceToken(), !token.isEmpty else { return nil }
        let body: JSONValue = .object([
            "type": .string("apns"),
            "deviceId": .string(configuration.deviceId.lowercased()),
            "development": .bool(configuration.development),
            "appId": .string(configuration.appId),
            "deviceToken": .string(token.map { String(format: "%02x", $0) }.joined()),
            "projectId": .string(configuration.projectId),
        ])
        let request = HTTPRequest(
            method: "POST", url: URL(string: "https://exp.host/--/api/v2/push/getExpoPushToken")!,
            headers: ["content-type": "application/json"], body: try body.encoded()
        )
        let response = try await transport.send(request)
        guard (200..<300).contains(response.status) else {
            throw APIError.http(status: response.status, body: String(decoding: response.body.prefix(512), as: UTF8.self))
        }
        let value = try JSONValue.decode(response.body)
        guard let expo = value["data"]?["expoPushToken"]?.stringValue, !expo.isEmpty else { throw SessionOpsError.malformedResponse }
        return expo
    }
}
