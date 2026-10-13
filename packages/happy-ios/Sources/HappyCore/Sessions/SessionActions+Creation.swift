import Foundation

extension SessionActions {
    /// Ports sync.ts ensureSessionReady: metadata plus both record/blob keys.
    public func ensureSessionReady(sessionId: String) async throws {
        try await sync.ensureSessionReady(sessionId: sessionId)
    }

    /// Ports sync.ts uploadSessionBlob, returning plaintext byte count with the ref.
    public func uploadSessionBlob(sessionId: String, name: String, bytes: Data) async throws -> (ref: String, size: Int) {
        try await sync.uploadSessionBlob(sessionId: sessionId, name: name, bytes: bytes)
    }
}
