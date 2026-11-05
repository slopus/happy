import Foundation
import HappyWire

/// Everything analytics keeps on this phone, in one file it alone writes
/// (`Application Support/Happy/analytics.json`): the install's random id,
/// the queue waiting to go, and the local state the catalog's rules need
/// (the error throttle, the failures already counted, each day's counts).
/// Nothing in it is sent except the queue's events.
public actor AnalyticsEngine {
    public static let lib = "happy-ios"
    public static let maxQueued = 500
    public static let maxAge: TimeInterval = 7 * 86_400
    /// A failure card older than this when first seen is history, not news.
    public static let failureFreshness: TimeInterval = 5 * 60
    public static let seenFailureLimit = 500

    public struct Destination: Sendable, Equatable {
        public var apiKey: String
        /// PostHog's `/batch/`, or a capture endpoint in a debug run.
        public var url: URL

        public init(apiKey: String, url: URL = URL(string: "https://us.i.posthog.com/batch/")!) {
            self.apiKey = apiKey; self.url = url
        }
    }

    struct Queued: Codable, Equatable, Sendable {
        var event: String
        var timestamp: Date
        /// Everything sent, `$insert_id` included, so a retry is the same event.
        var properties: [String: JSONValue]
        var insertID: String { properties["$insert_id"]?.stringValue ?? "" }
    }

    struct State: Codable, Equatable {
        var installID = UUID().uuidString.lowercased()
        var launchCount = 0
        var queue: [Queued] = []
        var throttle = ErrorThrottle()
        /// Days used and their counts by `DailyCount` name, until summarized.
        var days: [Int: [String: Int]] = [:]
        /// Failure messages already counted, oldest first.
        var seenFailures: [String] = []
    }

    private let destination: Destination
    private let file: URL?
    private let transport: HTTPTransport
    private var state = State()
    private var loaded = false
    private var saving: Task<Void, Never>?
    private var flushing = false

    public init(destination: Destination, file: URL?, transport: HTTPTransport) {
        self.destination = destination
        self.file = file
        self.transport = transport
    }

    // MARK: Recording

    public func record(_ event: AnalyticsEvent, common: [String: JSONValue], at now: Date) {
        load()
        enqueue(event, common: common, at: now)
    }

    /// `error_shown`, at most once per area and code every ten minutes; the
    /// ones held back ride on the next as `repeat_count`.
    public func recordError(area: AnalyticsEvent.ErrorArea, code: AnalyticsEvent.ErrorCode, common: [String: JSONValue], at now: Date) {
        load()
        guard let repeats = state.throttle.admit(area: area, code: code, at: now) else { return save() }
        enqueue(.errorShown(area: area, code: code, repeatCount: repeats), common: common, at: now)
    }

    /// `chat_failure_shown`, once per failure message, and only while it is
    /// news. The message's id stays here.
    public func recordFailureShown(messageID: String, createdAt: Date, _ event: AnalyticsEvent, common: [String: JSONValue], at now: Date) {
        load()
        guard now.timeIntervalSince(createdAt) <= Self.failureFreshness, !state.seenFailures.contains(messageID) else { return }
        state.seenFailures.append(messageID)
        if state.seenFailures.count > Self.seenFailureLimit { state.seenFailures.removeFirst(state.seenFailures.count - Self.seenFailureLimit) }
        enqueue(event, common: common, at: now)
    }

    public func count(_ count: AnalyticsEvent.DailyCount, by amount: Int, at now: Date) {
        load()
        guard amount > 0 else { return }
        state.days[Self.day(now), default: [:]][count.rawValue, default: 0] += amount
        save()
    }

    /// The day counts as used, so it gets its summary even with no counts.
    public func markUsed(at now: Date) {
        load()
        guard state.days[Self.day(now)] == nil else { return }
        state.days[Self.day(now)] = [:]
        save()
    }

    /// `app_opened`, after the summaries of the earlier days used (the last
    /// seven), each stamped noon UTC of its day.
    public func appOpened(cold: Bool, common: [String: JSONValue], config: AnalyticsEvent.DailyConfig, at now: Date) {
        load()
        let today = Self.day(now)
        for (day, counts) in state.days.sorted(by: { $0.key < $1.key }) where day < today {
            state.days[day] = nil
            guard day >= today - 7 else { continue }
            let typed = Dictionary(uniqueKeysWithValues: counts.compactMap { name, value in AnalyticsEvent.DailyCount(rawValue: name).map { ($0, value) } })
            let noon = Date(timeIntervalSince1970: TimeInterval(day) * 86_400 + 43_200)
            enqueue(.dailySummary(.init(day: day, counts: typed, config: config)), common: common, at: noon)
        }
        if cold { state.launchCount += 1 }
        enqueue(.appOpened(launchCount: state.launchCount, cold: cold), common: common, at: now)
        if state.days[today] == nil { state.days[today] = [:] }
    }

    /// Analytics turned off: what was waiting goes, and the counts with it.
    /// The install id stays.
    public func clear() {
        load()
        let id = state.installID
        state = State()
        state.installID = id
        save()
    }

    private func enqueue(_ event: AnalyticsEvent, common: [String: JSONValue], at now: Date) {
        guard var properties = AnalyticsSchema.admit(event.name, event.properties, common: common) else { return save() }
        properties["distinct_id"] = .string(state.installID)
        properties["$insert_id"] = .string(UUID().uuidString.lowercased())
        properties["$lib"] = .string(Self.lib)
        properties["$process_person_profile"] = .bool(false)
        properties["$ip"] = .null
        properties["$geoip_disable"] = .bool(true)
        state.queue.append(Queued(event: event.name, timestamp: now, properties: properties))
        prune(now: now)
        save()
    }

    private func prune(now: Date) {
        state.queue.removeAll { now.timeIntervalSince($0.timestamp) > Self.maxAge }
        if state.queue.count > Self.maxQueued { state.queue.removeFirst(state.queue.count - Self.maxQueued) }
    }

    static func day(_ date: Date) -> Int { Int((date.timeIntervalSince1970 / 86_400).rounded(.down)) }

    // MARK: Sending

    /// One `POST /batch/` with everything queued. Sent events leave the
    /// queue; on a network failure or a server error they stay for the
    /// next flush, and a request PostHog refuses outright is dropped rather
    /// than retried forever.
    public func flush(now: Date = Date()) async {
        load()
        prune(now: now)
        guard !flushing, !state.queue.isEmpty else { return }
        flushing = true
        defer { flushing = false }
        let batch = state.queue
        let status: Int
        do { status = try await transport.send(Self.request(batch, destination: destination)).status }
        catch { return }
        guard (200..<300).contains(status) || ((400..<500).contains(status) && status != 408 && status != 429) else { return }
        let sent = Set(batch.map(\.insertID))
        state.queue.removeAll { sent.contains($0.insertID) }
        save()
    }

    static func request(_ batch: [Queued], destination: Destination) -> HTTPRequest {
        let stamp = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        let body: JSONValue = .object([
            "api_key": .string(destination.apiKey),
            "batch": .array(batch.map { .object(["event": .string($0.event), "timestamp": .string($0.timestamp.formatted(stamp)), "properties": .object($0.properties)]) }),
        ])
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return HTTPRequest(method: "POST", url: destination.url, headers: ["Content-Type": "application/json"], body: try? encoder.encode(body))
    }

    // MARK: Disk

    private func load() {
        guard !loaded else { return }
        loaded = true
        guard let file, let data = try? Data(contentsOf: file), let stored = try? JSONDecoder().decode(State.self, from: data) else { return }
        state = stored
    }

    private func save() {
        guard file != nil, saving == nil else { return }
        saving = Task { [weak self] in
            try? await Task.sleep(for: .seconds(1))
            await self?.saveNow()
        }
    }

    /// Written at once, as the app goes to the background.
    public func saveNow() {
        saving?.cancel()
        saving = nil
        guard let file, let data = try? JSONEncoder().encode(state) else { return }
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: file, options: .atomic)
    }

    // MARK: Tests

    var snapshot: State { load(); return state }
}

/// `error_shown`'s rule: at most one per area and code every ten minutes
/// per device, with the occurrences held back in between counted onto the
/// next one sent.
struct ErrorThrottle: Codable, Equatable, Sendable {
    static let window: TimeInterval = 10 * 60

    struct Entry: Codable, Equatable, Sendable {
        var sentAt: Date
        var held: Int
    }

    var entries: [String: Entry] = [:]

    /// The `repeat_count` to send now, or nil when this one is held back.
    mutating func admit(area: AnalyticsEvent.ErrorArea, code: AnalyticsEvent.ErrorCode, at now: Date) -> Int? {
        let key = "\(area.rawValue)/\(code.rawValue)"
        if var entry = entries[key], now.timeIntervalSince(entry.sentAt) < Self.window {
            entry.held += 1
            entries[key] = entry
            return nil
        }
        let held = entries[key]?.held ?? 0
        entries[key] = Entry(sentAt: now, held: 0)
        // Old windows are let go of, so the table stays as small as the errors seen lately.
        entries = entries.filter { $0.key == key || now.timeIntervalSince($0.value.sentAt) < Self.window || $0.value.held > 0 }
        return held
    }
}
