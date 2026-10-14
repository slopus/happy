import Foundation

/// A draft's measured height, kept for one account session. Closing releases
/// its text and key permanently; a screen's teardown does not close its owner.
public final class MeasuredDraftMemo: @unchecked Sendable {
    public struct Entry: Sendable {
        public let text: String
        /// The UI's measurement key, without a Core dependency on its type.
        public let key: any Hashable & Sendable
        public let height: Double
    }

    private let lock = NSLock()
    private var kept: Entry?
    private var closed = false

    public init() {}

    /// The one kept entry when its text matches; nil after close.
    public func entry(for text: String) -> Entry? {
        lock.withLock {
            guard !closed, let kept, kept.text == text else { return nil }
            return kept
        }
    }

    /// Replaces the previous text and measurement. Ignored after close.
    public func keep(_ text: String, key: some Hashable & Sendable, height: Double) {
        lock.withLock {
            guard !closed else { return }
            kept = Entry(text: text, key: key, height: height)
        }
    }

    public var isClosed: Bool { lock.withLock { closed } }

    public func close() {
        lock.withLock {
            closed = true
            kept = nil
        }
    }
}