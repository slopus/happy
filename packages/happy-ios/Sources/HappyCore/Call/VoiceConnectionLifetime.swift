import Foundation

/// Calls share one audio device. A new connection waits until the
/// preceding connection has actually stopped, including a late startup
/// result after cancellation. A lease is released after SDK teardown.
@MainActor
public final class VoiceConnectionLifetime {
    private var tail: Task<Void, Never>?
    public init() {}
    public final class Lease {
        private var continuation: AsyncStream<Void>.Continuation?
        fileprivate init(_ continuation: AsyncStream<Void>.Continuation) { self.continuation = continuation }
        public func finish() { continuation?.finish(); continuation = nil }
    }
    public func acquire() async throws -> Lease {
        let previous = tail
        let (stream, continuation) = AsyncStream.makeStream(of: Void.self)
        tail = Task { for await _ in stream {} }
        await previous?.value
        do { try Task.checkCancellation() }
        catch { continuation.finish(); throw error }
        return Lease(continuation)
    }
}
