import Foundation

/// Where one picture or file of an outgoing message is on its way to the
/// computer, as Telegram's ring over a sending photo shows it. A message
/// that failed says so itself (`ChatItem.Delivery.failed`).
public enum UploadPhase: Equatable, Sendable {
    /// Waiting its turn, or being read and encoded: the ring spins.
    case preparing
    /// This share of its bytes written to the tunnel.
    case uploading(Double)
    /// All of it is there.
    case done
}

/// Every outgoing picture's and file's upload, keyed by the piece's id in
/// the message (`pictureKey`, `fileKey`). Uploads write from any thread;
/// the screen drains what changed at most once a frame, so however fast
/// bytes go out, each ring is touched once a frame with its latest value.
public final class UploadProgressBoard: @unchecked Sendable {
    public static let shared = UploadProgressBoard()

    /// Progress finer than this redraws nothing: a ring is at most a few
    /// hundred pixels round.
    public static let step = 1.0 / 512

    private let lock = NSLock()
    private var phases: [String: UploadPhase] = [:]
    private var changed: Set<String> = []
    private var signalled = false
    private var wake: (@Sendable () -> Void)?

    public init() {}

    /// The `index`th inline picture of message `id`: the same id its
    /// `ChatItem.Piece.picture` has.
    public static func pictureKey(_ id: String, _ index: Int) -> String { "\(id):\(index + 1)" }
    /// The `index`th file of message `id`, as its `.sentFile` piece.
    public static func fileKey(_ id: String, _ index: Int) -> String { "\(id):f\(index + 1)" }

    /// Which of a message's pictures or files a key names.
    public enum Piece: Equatable, Sendable {
        case picture(Int)
        case file(Int)
    }

    public static func piece(_ key: String, message id: String) -> Piece? {
        guard key.hasPrefix("\(id):") else { return nil }
        let rest = key.dropFirst(id.count + 1)
        if rest.hasPrefix("f") { return Int(rest.dropFirst()).flatMap { $0 > 0 ? .file($0 - 1) : nil } }
        return Int(rest).flatMap { $0 > 0 ? .picture($0 - 1) : nil }
    }

    /// Called once after the first change since the last `drain`, on the
    /// writer's thread.
    public func observe(_ wake: @escaping @Sendable () -> Void) {
        lock.withLock { self.wake = wake }
    }

    public func phase(_ key: String) -> UploadPhase? {
        lock.withLock { phases[key] }
    }

    public func set(_ key: String, _ phase: UploadPhase) {
        var phase = phase
        if case .uploading(let share) = phase {
            phase = .uploading((min(1, max(0, share)) / Self.step).rounded(.down) * Self.step)
        }
        let wake: (@Sendable () -> Void)? = lock.withLock {
            guard phases[key] != phase else { return nil }
            phases[key] = phase
            return mark(key)
        }
        wake?()
    }

    /// Message `id`'s pieces are forgotten: it went, or was taken back.
    public func clear(message id: String) {
        let prefix = "\(id):"
        let wake: (@Sendable () -> Void)? = lock.withLock {
            var wake: (@Sendable () -> Void)?
            for key in phases.keys where key.hasPrefix(prefix) {
                phases[key] = nil
                wake = mark(key) ?? wake
            }
            return wake
        }
        wake?()
    }

    private func mark(_ key: String) -> (@Sendable () -> Void)? {
        changed.insert(key)
        guard !signalled else { return nil }
        signalled = true
        return wake
    }

    /// What changed since the last drain, each once with its latest phase
    /// (nil: forgotten), in key order.
    public func drain() -> [(key: String, phase: UploadPhase?)] {
        lock.withLock {
            let out = changed.sorted().map { ($0, phases[$0]) }
            changed = []
            signalled = false
            return out
        }
    }

    /// Something is still on its way, so the screen keeps draining.
    public var active: Bool {
        lock.withLock { phases.values.contains { $0 != .done } }
    }
}

/// The bytes of a request body that are each inline picture's base64, so
/// the bytes written so far say how far each picture is.
struct UploadRanges: Equatable, Sendable {
    var ranges: [Range<Int>]

    /// Finds each of `encoded`, in order, in `body`.
    init(body: Data, encoded: [String]) {
        var from = body.startIndex
        ranges = encoded.map { string in
            let bytes = Data(string.utf8)
            let probe = bytes.prefix(64)
            guard !probe.isEmpty, let found = body.range(of: probe, in: from..<body.endIndex) else { return from..<from }
            let range = found.lowerBound..<min(body.endIndex, found.lowerBound + bytes.count)
            from = range.upperBound
            return (range.lowerBound - body.startIndex)..<(range.upperBound - body.startIndex)
        }
    }

    /// Each range's share written, once `sent` bytes of the body are.
    func shares(sent: Int) -> [Double] {
        ranges.map { range in
            guard !range.isEmpty else { return sent > range.lowerBound ? 1 : 0 }
            return min(1, max(0, Double(sent - range.lowerBound) / Double(range.count)))
        }
    }
}
