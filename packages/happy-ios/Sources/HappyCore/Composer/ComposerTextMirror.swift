import Foundation
import HappyStore

/// The composer's text, kept off the main thread from its edits (AGENTS.md
/// rule 8), so nothing on main copies or compares it as it grows.
///
/// The text view reports each edit as the text storage processes it: the
/// range it replaced and what replaced it, a keystroke's few units, read
/// from the storage in place (`edited(range:changeInLength:in:)`). Edits go
/// to a background drain in order, which applies them to its own copy.
/// Whoever needs the whole text (the height measurement, the draft writer)
/// takes a `snapshot()` on main, which costs nothing there: the drain
/// copies the text out when it reaches it, once per revision however many
/// ask.
public final class ComposerTextMirror: @unchecked Sendable {
    private enum Operation {
        case replace(NSRange, String)
        case capture(ComposerTextSnapshot)
    }

    // Main thread only.
    /// Moves with every edit.
    public private(set) var revision = 0
    /// The text's length in UTF-16 units, as the edits leave it.
    public private(set) var length = 0
    /// UTF-16 units handed over on the caller's thread so far: what the
    /// edits cost there (the operation-count tests).
    public private(set) var unitsHandedOver = 0
    private var latest: ComposerTextSnapshot?

    private let lock = NSLock()
    // Guarded by `lock`.
    private var queue: [Operation] = []
    private var draining = false

    // Touched only by the drain, which never runs twice at once.
    private let buffer = NSMutableString(string: "")

    public init() {}

    /// The text storage processed an edit: `editedRange` is where the new
    /// text sits in `units` (the storage's own string, read in place) and
    /// `changeInLength` how much it grew. Only the edited units are read.
    public func edited(range editedRange: NSRange, changeInLength: Int, in units: NSString) {
        let replaced = NSRange(location: editedRange.location, length: max(0, editedRange.length - changeInLength))
        replace(replaced, with: units.substring(with: editedRange))
    }

    /// Replaces `range` of the text with `replacement`.
    public func replace(_ range: NSRange, with replacement: String) {
        let units = replacement.utf16.count
        revision += 1
        length += units - range.length
        unitsHandedOver += units
        enqueue(.replace(range, replacement))
    }

    /// Starts again from `text`, after the mirror lost track of the view
    /// (its length disagrees). Costs the text's length here.
    public func reset(_ text: String) {
        replace(NSRange(location: 0, length: length), with: text)
    }

    /// The text as it is now, copied out off the main thread when needed.
    /// The same one until the next edit.
    public func snapshot() -> ComposerTextSnapshot {
        if let latest, latest.revision == revision { return latest }
        let snapshot = ComposerTextSnapshot(revision: revision)
        latest = snapshot
        enqueue(.capture(snapshot))
        return snapshot
    }

    private func enqueue(_ operation: Operation) {
        let start = lock.withLock {
            queue.append(operation)
            guard !draining else { return false }
            draining = true
            return true
        }
        if start {
            Task.detached(priority: .userInitiated) { self.drain() }
        }
    }

    private func drain() {
        ThreadRules.assertOffMain()
        while let batch = next() {
            for operation in batch {
                switch operation {
                case .replace(let range, let text):
                    buffer.replaceCharacters(in: range, with: text)
                case .capture(let snapshot):
                    // An immutable copy: the buffer moves on.
                    snapshot.fulfil(String(buffer.copy() as! NSString))
                }
            }
        }
    }

    private func next() -> [Operation]? {
        lock.withLock {
            guard !queue.isEmpty else {
                draining = false
                return nil
            }
            defer { queue.removeAll() }
            return queue
        }
    }
}

/// The composer's text at one revision, copied out off the main thread.
public final class ComposerTextSnapshot: @unchecked Sendable {
    public let revision: Int
    private let lock = NSLock()
    private var value: String?
    private var waiting: [CheckedContinuation<String, Never>] = []

    init(revision: Int) {
        self.revision = revision
    }

    /// The text, once the mirror has copied it out. Don't await it on main.
    public func text() async -> String {
        await withCheckedContinuation { continuation in
            let ready = lock.withLock { () -> String? in
                if let value { return value }
                waiting.append(continuation)
                return nil
            }
            if let ready { continuation.resume(returning: ready) }
        }
    }

    fileprivate func fulfil(_ text: String) {
        let waiters = lock.withLock {
            value = text
            defer { waiting = [] }
            return waiting
        }
        for waiter in waiters { waiter.resume(returning: text) }
    }
}

/// A draft text handed to the writer: one the composer holds as a string
/// (a stored draft it took, an empty field), or the field's own text at a
/// revision, read off the main thread.
public struct ComposerDraftText: Equatable, Sendable, ExpressibleByStringLiteral {
    private enum Source: Sendable {
        case string(String)
        case snapshot(ComposerTextSnapshot)
    }

    private let source: Source

    public init(_ string: String) {
        source = .string(string)
    }

    public init(_ snapshot: ComposerTextSnapshot) {
        source = .snapshot(snapshot)
    }

    public init(stringLiteral value: String) {
        self.init(value)
    }

    /// The text. Off the main thread: a snapshot is waited for.
    public func resolve() async -> String {
        switch source {
        case .string(let text): text
        case .snapshot(let snapshot): await snapshot.text()
        }
    }

    /// Strings by value, snapshots by identity; never a string's text
    /// against a snapshot's, which isn't known on main.
    public static func == (lhs: Self, rhs: Self) -> Bool {
        switch (lhs.source, rhs.source) {
        case (.string(let a), .string(let b)): a == b
        case (.snapshot(let a), .snapshot(let b)): a === b
        default: false
        }
    }
}
