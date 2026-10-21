import Foundation

/// Supplies a server-compatible Expo token, with APNs acquisition injected by the app.
public protocol PushTokenSource: Sendable {
    /// Acquires/exchanges this installation's token; nil if APNs has no token yet.
    func token() async throws -> String?
}

/// Account-scoped storage for pushRegistration's last successfully registered token.
public protocol PushRegistrationTokenCache: Sendable {
    /// Ports persistence.loadRegisteredPushToken.
    func loadToken() async throws -> String?

    /// Ports persistence.saveRegisteredPushToken.
    func saveToken(_ token: String) async throws

    /// Ports persistence.clearRegisteredPushToken.
    func clearToken() async throws
}

/// Registers only successfully exchanged tokens and exposes the last accepted one.
public actor TokenPushRegistration: PushRegistration {
    let source: any PushTokenSource
    let cache: (any PushRegistrationTokenCache)?
    var registeredToken: String?

    public init(source: any PushTokenSource) {
        self.source = source
        self.cache = nil
    }

    /// Uses account-scoped persistence so the Settings token identity survives relaunch.
    public init(source: any PushTokenSource, cache: any PushRegistrationTokenCache) {
        self.source = source
        self.cache = cache
    }

    /// Ports pushRegistration.getCurrentPushToken.
    public func currentToken() async -> String? {
        if let registeredToken { return registeredToken }
        let saved = try? await cache?.loadToken()
        // A registration may have completed while the cache read was awaiting.
        if registeredToken == nil { registeredToken = saved }
        return registeredToken
    }

    /// Ports pushRegistration.registerPushNotifications and apiPush.registerPushToken.
    public func register(api: HappyAPI) async throws -> String? {
        guard let token = try await source.token(), !token.isEmpty else { return nil }
        let previousToken = try await cache?.loadToken() ?? registeredToken
        try await api.registerPushToken(token)
        registeredToken = token
        try await cache?.saveToken(token)
        if let previousToken, previousToken != token {
            try? await api.unregisterPushToken(previousToken)
        }
        return token
    }

    /// Removes one token and forgets it only when it is the cached registration.
    public func removePushToken(api: HappyAPI, token: String) async throws {
        try await api.unregisterPushToken(token)
        let cached = try await cache?.loadToken() ?? registeredToken
        if cached == token {
            try await cache?.clearToken()
            registeredToken = nil
        }
    }
}
