import Foundation

/// This device's APNs token, after expo-notifications'
/// `getDevicePushTokenAsync` (`PushTokenModule.swift`): every request asks
/// UIKit to register for remote notifications again and waits for the
/// AppDelegate callback that follows. HappyCore imports no UIKit, so the
/// app injects the registration call and forwards both callbacks here.
public actor APNsTokenSource {
    private let register: @Sendable () async -> Void
    private var waiters: [CheckedContinuation<Data, any Error>] = []

    /// `register` calls `UIApplication.registerForRemoteNotifications()`.
    public init(register: @escaping @Sendable () async -> Void) {
        self.register = register
    }

    /// The token from the next callback; a failed registration throws its
    /// error. Requests made while one is waiting share its callback (expo
    /// instead rejects the older request with `E_PROMISE_REPLACED`), and
    /// each still asks UIKit again.
    public func token() async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            waiters.append(continuation)
            let register = self.register
            Task { await register() }
        }
    }

    /// `application(_:didRegisterForRemoteNotificationsWithDeviceToken:)`.
    /// A callback nobody waits for is dropped, as happy-app doesn't listen
    /// for token changes.
    public func didRegister(_ token: Data) {
        let waiting = waiters
        waiters = []
        for waiter in waiting { waiter.resume(returning: token) }
    }

    /// `application(_:didFailToRegisterForRemoteNotificationsWithError:)`.
    public func didFail(_ error: any Error) {
        let waiting = waiters
        waiters = []
        for waiter in waiting { waiter.resume(throwing: error) }
    }
}
