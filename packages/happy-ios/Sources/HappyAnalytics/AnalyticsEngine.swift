import Foundation
import HappyCore
import HappyWire

/// The queue waiting to go and the little the catalog's rules need (the
/// error throttle, the failures already reported), in memory only: unsent
/// events are lost when the app quits. The one thing kept on the phone is
/// the install's random id, and opting out deletes it.
public actor AnalyticsEngine {
    public static let lib = "happy-ios"
    public static let maxQueued = 500
    public static let maxAge: TimeInterval = 7 * 86_400
    /// A failure card older than this when first seen is history, not news.
    public static let failureFreshness: TimeInterval = 5 * 60
    public static let seenFailureLimit = 500
    static let installKey = "analytics.installID"

    public struct Destination: Sendable, Equatable {
        public var apiKey: String
        /// PostHog's `/batch/`, or a capture endpoint in a debug run.
        public var url: URL

        public init(apiKey: String, url: URL = URL(string: "https://us.i.posthog.com/batch/")!) {
            self.apiKey = apiKey; self.url = url
        }
    }

    struct Queued: Equatable, Sendable {
        var event: String
        var timestamp: Date
        /// Everything sent, `$insert_id` included, so a retry is the same event.
        var properties: [String: JSONValue]
        var insertID: String { properties["$insert_id"]?.stringValue ?? "" }
    }

    private let destination: Destination
    private let transport: HTTPTransport
    /// Where the install id is kept, and nothing else.
    private let storage: KeyValueStore
    private var id: String?
    private(set) var queue: [Queued] = []
    private var throttle = ErrorThrottle()
    private(set) var seenFailures: [String] = []
    private var flushing = false
    /// Opted out: nothing is recorded or sent until `resume`.
    private var paused = false

    public init(destination: Destination, transport: HTTPTransport, storage: KeyValueStore) {
        self.destination = destination
        self.transport = transport
        self.storage = storage
    }

    /// The random id every event carries as `distinct_id`, made the first
    /// time it is needed after the app is installed or analytics is turned
    /// back on. Nil while it is off, when there is none.
    public var installID: String? {
        guard !paused else { return nil }
        if let id { return id }
        let stored = storage.string(forKey: Self.installKey)
        let id = stored.flatMap(UUID.init(uuidString:)).map { $0.uuidString.lowercased() } ?? UUID().uuidString.lowercased()
        if stored != id { storage.set(id, forKey: Self.installKey) }
        self.id = id
        return id
    }

    // MARK: Recording

    public func record(_ event: AnalyticsEvent, common: [String: JSONValue], at now: Date) {
        guard !paused, let installID else { return }
        guard let properties = AnalyticsSchema.admit(event.name, event.properties, common: common) else { return }
        // Whole seconds only.
        let at = Date(timeIntervalSince1970: now.timeIntervalSince1970.rounded(.down))
        queue.append(Queued(event: event.name, timestamp: at, properties: Self.envelope(properties, installID: installID)))
        prune(now: now)
    }

    /// `error_shown`, at most once per area and code every ten minutes;
    /// the ones in between are dropped. One failure reached by two paths
    /// at once, such as a conversation read when it opens and again on the
    /// resync that follows, is one event: within `ErrorThrottle.burst` of
    /// one still queued for the same area, a specific code takes the place
    /// of `unknown` and anything else is dropped.
    public func recordError(area: AnalyticsEvent.ErrorArea, code: AnalyticsEvent.ErrorCode, common: [String: JSONValue], at now: Date) {
        guard !paused else { return }
        if let index = queue.lastIndex(where: {
            $0.event == "error_shown" && $0.properties["area"] == .string(area.rawValue) && now.timeIntervalSince($0.timestamp) < ErrorThrottle.burst
        }) {
            if queue[index].properties["code"] == .string(AnalyticsEvent.ErrorCode.unknown.rawValue), code != .unknown,
               throttle.admit(area: area, code: code, at: now) {
                queue[index].properties["code"] = .string(code.rawValue)
            }
            return
        }
        guard throttle.admit(area: area, code: code, at: now) else { return }
        record(.errorShown(area: area, code: code), common: common, at: now)
    }

    /// `chat_failure_shown`, once per failure message, and only while it is
    /// news. The message's id stays here, in memory.
    public func recordFailureShown(messageID: String, createdAt: Date, _ event: AnalyticsEvent, common: [String: JSONValue], at now: Date) {
        guard !paused, now.timeIntervalSince(createdAt) <= Self.failureFreshness, !seenFailures.contains(messageID) else { return }
        seenFailures.append(messageID)
        if seenFailures.count > Self.seenFailureLimit { seenFailures.removeFirst(seenFailures.count - Self.seenFailureLimit) }
        record(event, common: common, at: now)
    }

    /// Analytics turned off: the queue, the throttle, the failures seen and
    /// the install id go, and nothing is recorded or sent until `resume`.
    public func clear() {
        paused = true
        queue = []
        throttle = ErrorThrottle()
        seenFailures = []
        id = nil
        storage.set(nil, forKey: Self.installKey)
    }

    /// Analytics allowed again: the next event makes a new install id.
    public func resume() {
        paused = false
    }

    /// The catalog's properties with the fixed privacy envelope around them.
    private static func envelope(_ properties: [String: JSONValue], installID: String) -> [String: JSONValue] {
        var properties = properties
        properties["distinct_id"] = .string(installID)
        properties["$insert_id"] = .string(UUID().uuidString.lowercased())
        properties["$lib"] = .string(lib)
        properties["$process_person_profile"] = .bool(false)
        properties["$ip"] = .null
        properties["$geoip_disable"] = .bool(true)
        return properties
    }

    private func prune(now: Date) {
        queue.removeAll { now.timeIntervalSince($0.timestamp) > Self.maxAge }
        if queue.count > Self.maxQueued { queue.removeFirst(queue.count - Self.maxQueued) }
    }

    // MARK: Sending

    /// One `POST /batch/` with everything queued. Sent events leave the
    /// queue; on a network failure or a server error they stay for the
    /// next flush, and a request PostHog refuses outright is dropped rather
    /// than retried forever. A clear while it is on its way leaves nothing
    /// of it to keep.
    public func flush(now: Date = Date()) async {
        prune(now: now)
        guard !paused, !flushing, !queue.isEmpty else { return }
        flushing = true
        defer { flushing = false }
        let batch = queue
        let status: Int
        do { status = try await transport.send(Self.request(batch, destination: destination)).status }
        catch { return }
        guard (200..<300).contains(status) || ((400..<500).contains(status) && status != 408 && status != 429) else { return }
        let sent = Set(batch.map(\.insertID))
        queue.removeAll { sent.contains($0.insertID) }
    }

    static func request(_ batch: [Queued], destination: Destination) -> HTTPRequest {
        let stamp = Date.ISO8601FormatStyle()
        let body: JSONValue = .object([
            "api_key": .string(destination.apiKey),
            "batch": .array(batch.map { .object(["event": .string($0.event), "timestamp": .string($0.timestamp.formatted(stamp)), "properties": .object($0.properties)]) }),
        ])
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return HTTPRequest(method: "POST", url: destination.url, headers: ["Content-Type": "application/json"], body: try? encoder.encode(body))
    }
}

/// `error_shown`'s rule: at most one per area and code every ten minutes
/// per device; the rest are dropped, not counted.
struct ErrorThrottle: Equatable, Sendable {
    static let window: TimeInterval = 10 * 60
    /// How close together two of one area's errors are one failure.
    static let burst: TimeInterval = 10

    var sentAt: [String: Date] = [:]

    /// Whether this one goes.
    mutating func admit(area: AnalyticsEvent.ErrorArea, code: AnalyticsEvent.ErrorCode, at now: Date) -> Bool {
        let key = "\(area.rawValue)/\(code.rawValue)"
        if let last = sentAt[key], now.timeIntervalSince(last) < Self.window { return false }
        // Old windows are let go of, so the table stays as small as the errors seen lately.
        sentAt = sentAt.filter { now.timeIntervalSince($0.value) < Self.window }
        sentAt[key] = now
        return true
    }
}
