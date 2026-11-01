import Foundation

/// The ways an account's traffic leaves this phone, counted apart.
public enum ConnectionChannel: Int, CaseIterable, Sendable {
    /// The Happy server's HTTP API (a Happy CLI account).
    case http
    /// The Happy server's Socket.IO, over a WebSocket.
    case socket
    /// The computer's API and its event stream, over the Tailcat tunnel.
    case tailcat
    /// Media and file bytes: presigned storage downloads for a Happy CLI
    /// account, the media and file routes over Tailcat for a computer.
    case media
    /// The browser's and artifacts' proxy streams, over Tailcat.
    case browser

    public var name: String {
        switch self {
        case .http: "HTTP"
        case .socket: "Socket.IO"
        case .tailcat: "Tailcat"
        case .media: "Media"
        case .browser: "Browser proxy"
        }
    }
}

/// What is counted on each channel, in each bucket.
public enum ConnectionCounter: Int, CaseIterable, Sendable {
    case bytesSent, bytesReceived
    case connectionsOpened, connectionsClosed
    case requests2xx, requests3xx, requests4xx, requests5xx, requestsFailed
    /// Long-lived streams: Socket.IO's WebSocket, the computer's event stream.
    case streamsOpened, streamsClosed, streamReconnects

    /// The counter an answer with `status` goes in; nil status is a request
    /// that got no answer.
    public static func request(status: Int?) -> ConnectionCounter {
        switch status {
        case .some(200..<300): .requests2xx
        case .some(300..<400): .requests3xx
        case .some(400..<500): .requests4xx
        case .some(500...): .requests5xx
        default: .requestsFailed
        }
    }
}

/// Request times as counts in geometric bins, so a window's percentiles
/// cost a fixed amount of memory however many requests it saw. Bin `i`
/// holds times up to `edges[i]` milliseconds; the last holds the rest.
public enum LatencyBins {
    /// 1 ms × 1.25ⁱ up to two minutes: every percentile within 25 %.
    public static let edges: [Double] = {
        var edges: [Double] = []
        var edge = 1.0
        while edge < 120_000 { edges.append(edge); edge *= 1.25 }
        edges.append(edge)
        return edges
    }()
    public static var count: Int { edges.count + 1 }

    public static func bin(milliseconds: Double) -> Int {
        // Binary search: the first edge at or over the time.
        var low = 0, high = edges.count
        while low < high {
            let mid = (low + high) / 2
            if edges[mid] < milliseconds { low = mid + 1 } else { high = mid }
        }
        return low
    }

    /// The upper edge of the bin the `fraction`th time falls in (the slowest
    /// a request at that rank could have been), nil with none counted.
    public static func percentile(_ fraction: Double, of counts: [Int64]) -> Double? {
        let total = counts.reduce(0, +)
        guard total > 0 else { return nil }
        let rank = max(1, Int64((Double(total) * fraction).rounded(.up)))
        var seen: Int64 = 0
        for (index, count) in counts.enumerated() {
            seen += count
            if seen >= rank { return index < edges.count ? edges[index] : edges[edges.count - 1] }
        }
        return edges.last
    }
}

/// The last ten minutes of an account's traffic as sixty ten-second
/// buckets in a ring. A bucket is reused once its ten seconds are more
/// than ten minutes old: it is zeroed when the first count of its new
/// time lands, so an idle stretch costs nothing. Pure, with time passed
/// in, so it is tested with a made-up clock.
public struct MetricsRing: Equatable, Sendable {
    public static let bucketSeconds = 10
    public static let bucketCount = 60
    public static var windowSeconds: Int { bucketSeconds * bucketCount }

    private static let counters = ConnectionCounter.allCases.count
    private static let channels = ConnectionChannel.allCases.count
    private static let bins = LatencyBins.count

    /// Which ten seconds each slot holds now (seconds / 10); -1 for none yet.
    private var epochs = [Int64](repeating: -1, count: bucketCount)
    private var counts = [Int64](repeating: 0, count: bucketCount * channels * counters)
    private var latency = [UInt32](repeating: 0, count: bucketCount * channels * bins)

    public init() {}

    public static func epoch(_ time: TimeInterval) -> Int64 { Int64((time / Double(bucketSeconds)).rounded(.down)) }

    /// The slot for `time`, emptied first when it still holds an older time.
    /// A count older than the window is dropped (nil).
    private mutating func slot(_ time: TimeInterval) -> Int? {
        let epoch = Self.epoch(time)
        guard epoch >= 0 else { return nil }
        let slot = Int(epoch % Int64(Self.bucketCount))
        if epochs[slot] == epoch { return slot }
        // Older than what the slot holds: from before the window.
        if epochs[slot] > epoch { return nil }
        epochs[slot] = epoch
        let c = Self.channels * Self.counters, l = Self.channels * Self.bins
        for i in slot * c..<(slot + 1) * c { counts[i] = 0 }
        for i in slot * l..<(slot + 1) * l { latency[i] = 0 }
        return slot
    }

    public mutating func add(_ counter: ConnectionCounter, _ channel: ConnectionChannel, _ amount: Int64 = 1, at time: TimeInterval) {
        guard amount != 0, let slot = slot(time) else { return }
        counts[(slot * Self.channels + channel.rawValue) * Self.counters + counter.rawValue] += amount
    }

    public mutating func addLatency(seconds: TimeInterval, _ channel: ConnectionChannel, at time: TimeInterval) {
        guard let slot = slot(time) else { return }
        latency[(slot * Self.channels + channel.rawValue) * Self.bins + LatencyBins.bin(milliseconds: seconds * 1000)] += 1
    }

    /// The window ending at `time`: the bucket `time` is in and the 59
    /// before it.
    public func totals(at time: TimeInterval) -> MetricsTotals {
        let now = Self.epoch(time)
        let oldest = now - Int64(Self.bucketCount) + 1
        var totals = MetricsTotals()
        for slot in 0..<Self.bucketCount {
            let epoch = epochs[slot]
            guard epoch >= oldest, epoch <= now else { continue }
            // Six buckets a minute, the oldest minute first.
            let minute = Int(epoch - oldest) / (60 / Self.bucketSeconds)
            for channel in ConnectionChannel.allCases {
                let base = (slot * Self.channels + channel.rawValue) * Self.counters
                for counter in ConnectionCounter.allCases {
                    totals.counts[channel.rawValue * Self.counters + counter.rawValue] += counts[base + counter.rawValue]
                }
                totals.bytesPerMinute[minute] += counts[base + ConnectionCounter.bytesSent.rawValue] + counts[base + ConnectionCounter.bytesReceived.rawValue]
                let bins = (slot * Self.channels + channel.rawValue) * Self.bins
                for bin in 0..<Self.bins { totals.latency[channel.rawValue * Self.bins + bin] += Int64(latency[bins + bin]) }
            }
        }
        return totals
    }
}

/// A window's sums, by channel.
public struct MetricsTotals: Equatable, Sendable {
    public static let minutes = MetricsRing.windowSeconds / 60

    fileprivate var counts = [Int64](repeating: 0, count: ConnectionChannel.allCases.count * ConnectionCounter.allCases.count)
    fileprivate var latency = [Int64](repeating: 0, count: ConnectionChannel.allCases.count * LatencyBins.count)
    /// Bytes sent and received each minute, every channel, the oldest first.
    public var bytesPerMinute = [Int64](repeating: 0, count: minutes)

    public init() {}

    public func count(_ counter: ConnectionCounter, _ channel: ConnectionChannel) -> Int64 {
        counts[channel.rawValue * ConnectionCounter.allCases.count + counter.rawValue]
    }

    /// `counter` over `channels` (all of them by default).
    public func count(_ counter: ConnectionCounter, on channels: [ConnectionChannel] = ConnectionChannel.allCases) -> Int64 {
        channels.reduce(0) { $0 + count(counter, $1) }
    }

    public func requests(on channels: [ConnectionChannel] = ConnectionChannel.allCases) -> Int64 {
        [ConnectionCounter.requests2xx, .requests3xx, .requests4xx, .requests5xx, .requestsFailed].reduce(0) { $0 + count($1, on: channels) }
    }

    /// Requests answered 5xx or not at all.
    public func failures(on channels: [ConnectionChannel] = ConnectionChannel.allCases) -> Int64 {
        count(.requests5xx, on: channels) + count(.requestsFailed, on: channels)
    }

    /// The `fraction` request time in seconds over `channels`, nil with none.
    public func latency(_ fraction: Double, on channels: [ConnectionChannel] = ConnectionChannel.allCases) -> TimeInterval? {
        var merged = [Int64](repeating: 0, count: LatencyBins.count)
        for channel in channels {
            for bin in 0..<LatencyBins.count { merged[bin] += latency[channel.rawValue * LatencyBins.count + bin] }
        }
        return LatencyBins.percentile(fraction, of: merged).map { $0 / 1000 }
    }

    public var channelsUsed: [ConnectionChannel] {
        ConnectionChannel.allCases.filter { channel in ConnectionCounter.allCases.contains { count($0, channel) != 0 } }
    }
}

/// How a Tailcat tunnel reaches the computer, as tailcat-swift says it.
public enum TunnelPath: Equatable, Sendable {
    /// Through a DERP relay.
    case relayed
    /// Peer to peer over UDP, to this endpoint.
    case direct(endpoint: String)
}

/// One Tailcat tunnel this account has up: which relay it was given, which
/// computer it reaches (its public node key, never the secret address).
public struct TunnelInfo: Equatable, Sendable {
    public var regionID: Int
    public var regionCode: String
    public var regionName: String
    /// The relay's host name.
    public var relayHost: String?
    /// The computer's node key, shortened: public, so safe to show.
    public var nodeKey: String
    public var port: UInt16

    public init(regionID: Int, regionCode: String = "", regionName: String = "", relayHost: String? = nil, nodeKey: String, port: UInt16) {
        self.regionID = regionID; self.regionCode = regionCode; self.regionName = regionName
        self.relayHost = relayHost; self.nodeKey = nodeKey; self.port = port
    }

    /// "Frankfurt" (its name), "fra" (its code), or "region 4".
    public var regionLabel: String {
        if !regionName.isEmpty { return regionName }
        if !regionCode.isEmpty { return regionCode }
        return "region \(regionID)"
    }
}

/// What a page shows of an account's link at one moment: the window's
/// sums and what is up now.
public struct ConnectionSnapshot: Equatable, Sendable {
    public var totals = MetricsTotals()
    /// When this was taken, on the recorder's clock.
    public var time: TimeInterval = 0
    /// How long the recorder has been counting, at most the window.
    public var counted: TimeInterval = 0
    /// The newest tunnel up, and how many are.
    public var tunnel: TunnelInfo?
    public var tunnels = 0
    public var tunnelSince: TimeInterval?
    public var path: TunnelPath?
    /// TCP flows open over Tailcat now, this phone's side.
    public var liveFlows = 0
    /// Streams open now by channel, and since when the oldest of them is.
    public var openStreams: [ConnectionChannel: Int] = [:]
    public var streamSince: [ConnectionChannel: TimeInterval] = [:]
    public var lastError: String?
    public var lastErrorAt: TimeInterval?

    public init() {}

    /// Seconds since `start`, at this snapshot.
    public func age(_ start: TimeInterval?) -> TimeInterval? { start.map { max(0, time - $0) } }
}

/// One account's traffic recorder, in memory only: it starts empty with the
/// account's session and goes with it. Every transport the account uses
/// reports to it from wherever it runs (none of them on the main thread);
/// each report is one short uncontended lock and a few adds into fixed
/// arrays, never an allocation, a task or a hop to another actor. Reading
/// it is for a page on screen, about once a second, off the main thread.
public final class ConnectionMetrics: @unchecked Sendable {
    public typealias Clock = @Sendable () -> TimeInterval
    /// Monotonic seconds: the time a phone's clock is set to never moves it.
    public static let uptime: Clock = { TimeInterval(DispatchTime.now().uptimeNanoseconds) / 1_000_000_000 }

    private let lock = NSLock()
    private let now: Clock
    private let started: TimeInterval
    private var ring = MetricsRing()
    private var everOpened = Set<ConnectionChannel>()
    private var open: [ConnectionChannel: Int] = [:]
    private var since: [ConnectionChannel: TimeInterval] = [:]
    private var liveFlows = 0
    private struct Tunnel {
        var info: TunnelInfo
        var since: TimeInterval
        var path: @Sendable () async -> TunnelPath?
    }
    private var tunnels: [UUID: Tunnel] = [:]
    private var newestTunnel: UUID?
    private var lastError: (String, TimeInterval)?

    public init(clock: @escaping Clock = ConnectionMetrics.uptime) {
        now = clock
        started = clock()
    }

    private func locked<T>(_ body: (TimeInterval) -> T) -> T {
        let time = now()
        lock.lock(); defer { lock.unlock() }
        return body(time)
    }

    // MARK: Reports

    public func add(_ counter: ConnectionCounter, _ channel: ConnectionChannel, _ amount: Int = 1) {
        guard amount != 0 else { return }
        locked { ring.add(counter, channel, Int64(amount), at: $0) }
    }

    public func sent(_ bytes: Int, on channel: ConnectionChannel) { add(.bytesSent, channel, bytes) }
    public func received(_ bytes: Int, on channel: ConnectionChannel) { add(.bytesReceived, channel, bytes) }

    /// A request answered with `status`, or not answered (nil), after `duration`.
    public func request(_ channel: ConnectionChannel, status: Int?, duration: TimeInterval) {
        locked { time in
            ring.add(.request(status: status), channel, at: time)
            // A request that failed says nothing about how fast the link is.
            if status != nil { ring.addLatency(seconds: duration, channel, at: time) }
        }
    }

    /// A TCP flow over the tunnel opened (`flow`) or another connection.
    public func connectionOpened(_ channel: ConnectionChannel, flow: Bool = false) {
        locked { time in
            ring.add(.connectionsOpened, channel, at: time)
            if flow { liveFlows += 1 }
        }
    }

    public func connectionClosed(_ channel: ConnectionChannel, flow: Bool = false) {
        locked { time in
            ring.add(.connectionsClosed, channel, at: time)
            if flow { liveFlows = max(0, liveFlows - 1) }
        }
    }

    /// A long-lived stream opened: one after an earlier one on the same
    /// channel is a reconnect.
    public func streamOpened(_ channel: ConnectionChannel) {
        locked { time in
            ring.add(.streamsOpened, channel, at: time)
            if !everOpened.insert(channel).inserted { ring.add(.streamReconnects, channel, at: time) }
            if open[channel, default: 0] == 0 { since[channel] = time }
            open[channel, default: 0] += 1
        }
    }

    public func streamClosed(_ channel: ConnectionChannel) {
        locked { time in
            ring.add(.streamsClosed, channel, at: time)
            let left = max(0, open[channel, default: 0] - 1)
            open[channel] = left
            if left == 0 { since[channel] = nil }
        }
    }

    /// A tunnel came up; `path` asks it how it reaches the computer now.
    public func tunnelUp(_ id: UUID, info: TunnelInfo, path: @escaping @Sendable () async -> TunnelPath?) {
        locked { time in
            tunnels[id] = Tunnel(info: info, since: time, path: path)
            newestTunnel = id
        }
    }

    public func tunnelDown(_ id: UUID) {
        locked { _ in
            tunnels[id] = nil
            if newestTunnel == id { newestTunnel = tunnels.max { $0.value.since < $1.value.since }?.key }
        }
    }

    /// The last thing that went wrong, in words that hold no secret.
    public func failed(_ description: String) {
        locked { lastError = (description, $0) }
    }

    // MARK: Reading

    /// The window and the state now. The path is asked of the newest
    /// tunnel, so this waits on its actor: never call it on the main thread.
    public func snapshot() async -> ConnectionSnapshot {
        let (snapshot, probe) = locked { time -> (ConnectionSnapshot, (@Sendable () async -> TunnelPath?)?) in
            var value = ConnectionSnapshot()
            value.time = time
            value.counted = min(time - started, TimeInterval(MetricsRing.windowSeconds))
            value.totals = ring.totals(at: time)
            value.tunnels = tunnels.count
            let newest = newestTunnel.flatMap { tunnels[$0] }
            value.tunnel = newest?.info
            value.tunnelSince = newest?.since
            value.liveFlows = liveFlows
            value.openStreams = open.filter { $0.value > 0 }
            value.streamSince = since
            value.lastError = lastError?.0
            value.lastErrorAt = lastError?.1
            return (value, newest?.path)
        }
        var result = snapshot
        result.path = await probe?()
        return result
    }
}

/// The recorder and channel a request's lower layers report to, set by
/// the metered transport around the call it makes: the Tailcat flows a
/// request opens count where the request said, and URLSession's own
/// connections count for the account that asked.
public enum MetricsScope {
    @TaskLocal public static var channel: ConnectionChannel?
    @TaskLocal public static var metrics: ConnectionMetrics?
}
