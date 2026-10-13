import Foundation

public protocol PushTokenSource: Sendable {
    func token() async throws -> String?
}
public actor TokenPushRegistration: PushRegistration {
    let source: any PushTokenSource
    var registeredToken: String?
    public init(source: any PushTokenSource) { self.source = source }
    /// Ports pushRegistration.getCurrentPushToken.
    public func currentToken() async -> String? { registeredToken }
    /// Ports pushRegistration.registerPushNotifications and apiPush.registerPushToken.
    public func register(api: HappyAPI) async throws -> String? { throw SessionOpsError.notImplemented }
}