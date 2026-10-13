import Foundation

extension HappyAPI {
    /// Ports apiPush.registerPushToken.
    public func registerPushToken(_ token: String) async throws { throw SessionOpsError.notImplemented }
    /// Ports ops.ts machineDelete.
    public func deleteMachine(id: String) async throws { throw SessionOpsError.notImplemented }
}