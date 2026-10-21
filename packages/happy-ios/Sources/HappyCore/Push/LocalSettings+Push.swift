import Foundation

extension LocalSettings: PushRegistrationTokenCache {
    /// Ports persistence.loadRegisteredPushToken from this account's local suite.
    public func loadToken() async throws -> String? {
        registeredPushToken
    }

    /// Ports persistence.saveRegisteredPushToken in this account's local suite.
    public func saveToken(_ token: String) async throws {
        registeredPushToken = token
    }

    public func clearToken() async throws {
        registeredPushToken = nil
    }
}
