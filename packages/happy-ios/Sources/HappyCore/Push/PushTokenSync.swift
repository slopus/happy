import Foundation

/// The Expo token source for this installation: APNs bytes, the
/// installation id and the signing environment, exchanged by
/// `ExpoPushTokenExchange`. The id is read on every request, as
/// `getExpoPushTokenAsync` does, so a Keychain failure fails that request
/// only.
public struct ExpoDevicePushTokenSource: PushTokenSource {
    private let transport: any HTTPTransport
    private let installationID: ExpoInstallationID
    private let development: Bool
    private let appId: String
    private let deviceToken: @Sendable () async throws -> Data?

    /// `development` is `ProvisioningProfile.usesDevelopmentAPNs`, `appId`
    /// the running bundle id, `deviceToken` `APNsTokenSource.token`.
    public init(transport: any HTTPTransport, installationID: ExpoInstallationID, development: Bool, appId: String,
                deviceToken: @escaping @Sendable () async throws -> Data?) {
        self.transport = transport
        self.installationID = installationID
        self.development = development
        self.appId = appId
        self.deviceToken = deviceToken
    }

    public func token() async throws -> String? {
        let configuration = ExpoPushTokenExchange.Configuration(
            deviceId: try installationID.read(), development: development, appId: appId)
        return try await ExpoPushTokenExchange(transport: transport, configuration: configuration, deviceToken: deviceToken).token()
    }
}

/// sync.ts `pushTokenSync`: registers this device's token with the active
/// account when its session starts and every time the app becomes active.
/// Runs coalesce like `InvalidateSync`: invalidating during a run queues
/// exactly one more. Failures are dropped, as `registerPushToken` logs
/// them; the next invalidation tries again.
public actor PushTokenSync {
    /// The active account's registration and API, read as each run starts.
    public struct Target: Sendable {
        public var registration: any PushRegistration
        public var api: HappyAPI

        public init(registration: any PushRegistration, api: HappyAPI) {
            self.registration = registration
            self.api = api
        }
    }

    /// `SyncCurrentPushTokenResult`.
    public struct SyncResult: Equatable, Sendable {
        public var registered: Bool
        public var token: String?
        public var permission: PushPermission
    }

    /// expo-notifications' `getPermissionsAsync` and
    /// `requestPermissionsAsync` (alert, badge and sound), normalized.
    public struct Permissions: Sendable {
        public var current: @Sendable () async -> PushPermission
        public var request: @Sendable () async -> PushPermission

        public init(current: @escaping @Sendable () async -> PushPermission,
                    request: @escaping @Sendable () async -> PushPermission) {
            self.current = current
            self.request = request
        }
    }

    private let target: @Sendable () async -> Target?
    private let permissions: Permissions
    private var running = false
    private var queued = false
    private var idle: [CheckedContinuation<Void, Never>] = []

    public init(permissions: Permissions, target: @escaping @Sendable () async -> Target?) {
        self.permissions = permissions
        self.target = target
    }

    /// `InvalidateSync.invalidate`.
    public func invalidate() {
        if running {
            queued = true
            return
        }
        running = true
        Task { await run() }
    }

    /// `InvalidateSync.awaitQueue`: returns once no run is going or queued.
    public func awaitQueue() async {
        guard running else { return }
        await withCheckedContinuation { idle.append($0) }
    }

    private func run() async {
        repeat {
            queued = false
            if let target = await target() {
                _ = try? await Self.syncCurrentPushToken(target, permissions: permissions)
            }
        } while queued
        running = false
        let waiting = idle
        idle = []
        for waiter in waiting { waiter.resume() }
    }

    /// pushRegistration.ts `syncCurrentPushToken` on iOS: ask while iOS
    /// still can (so the first sign-in shows the prompt), then register the
    /// current token. Replacing a previously registered token is
    /// `register`'s job. Throws what the exchange or the server throws.
    public static func syncCurrentPushToken(_ target: Target, permissions: Permissions) async throws -> SyncResult {
        var permission = await permissions.current()
        if !permission.granted {
            guard permission.canAskAgain else {
                return SyncResult(registered: false, token: await target.registration.currentToken(), permission: permission)
            }
            permission = await permissions.request()
            guard permission.granted else {
                return SyncResult(registered: false, token: await target.registration.currentToken(), permission: permission)
            }
        }
        guard let token = try await target.registration.register(api: target.api) else {
            return SyncResult(registered: false, token: await target.registration.currentToken(), permission: permission)
        }
        return SyncResult(registered: true, token: token, permission: permission)
    }
}
