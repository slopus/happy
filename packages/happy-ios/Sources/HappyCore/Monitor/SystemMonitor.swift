import Foundation
import HappyWire

/// One reading of the computer's System Monitor
/// (`GET /v0/surfaces/system-monitor/:surfaceId`, happy-agent API.md): the
/// host, CPU, memory, graphics, volumes, disk traffic and busiest
/// processes, with the sampler's recent history. Every measurement the
/// daemon can't take is nil, never zero.
public struct SystemMonitorSample: Codable, Equatable, Sendable {
    public struct Host: Codable, Equatable, Sendable {
        public var hostname: String
        public var platform: String
        public var arch: String
        public var osName: String
        public var uptimeSeconds: Double
    }

    public struct CPU: Codable, Equatable, Sendable {
        public var model: String
        public var logicalCores: Int
        public var usagePercent: Double?
        public var perCoreUsagePercent: [Double]?
        public var loadAverage: [Double]?
        public var speedMhz: Double?
        public var temperatureCelsius: Double?
    }

    public struct Memory: Codable, Equatable, Sendable {
        public var totalBytes: Double
        public var usedBytes: Double
        public var availableBytes: Double
        public var cachedBytes: Double?
        public var swapTotalBytes: Double?
        public var swapUsedBytes: Double?
    }

    public struct GPU: Codable, Equatable, Sendable {
        public var name: String
        public var vendor: String?
        public var usagePercent: Double?
        public var memoryTotalBytes: Double?
        public var memoryUsedBytes: Double?
        public var temperatureCelsius: Double?
        public var powerWatts: Double?
    }

    public struct Disk: Codable, Equatable, Sendable {
        public var mountPoint: String
        public var device: String
        public var fileSystem: String?
        public var totalBytes: Double
        public var usedBytes: Double
        public var availableBytes: Double
    }

    public struct DiskIO: Codable, Equatable, Sendable {
        public var readBytesPerSecond: Double
        public var writeBytesPerSecond: Double
    }

    public struct Process: Codable, Equatable, Sendable {
        public var pid: Int
        public var parentPid: Int?
        public var name: String
        public var user: String?
        public var state: String?
        public var cpuPercent: Double?
        public var memoryBytes: Double
        public var threads: Int?
        public var startedAt: Double?
    }

    public struct Processes: Codable, Equatable, Sendable {
        public var total: Int
        public var threads: Int?
        public var items: [Process]
    }

    public struct Point: Codable, Equatable, Sendable {
        public var sampledAt: Double
        public var cpuPercent: Double?
        public var memoryUsedBytes: Double?
        public var gpuPercent: Double?
        public var diskReadBytesPerSecond: Double?
        public var diskWriteBytesPerSecond: Double?
    }

    /// Milliseconds since 1970.
    public var sampledAt: Double
    public var intervalMs: Double
    public var host: Host
    public var cpu: CPU
    public var memory: Memory
    public var gpus: [GPU]
    public var disks: [Disk]
    public var diskIo: DiskIO?
    public var processes: Processes?
    /// Oldest first, at most 300.
    public var history: [Point]

    /// The busiest graphics device's use, as the history's `gpuPercent`.
    public var gpuPercent: Double? { gpus.compactMap(\.usagePercent).max() }

    /// All volumes together: used and total bytes.
    public var diskUsed: Double { disks.reduce(0) { $0 + $1.usedBytes } }
    public var diskTotal: Double { disks.reduce(0) { $0 + $1.totalBytes } }
}

/// How busy something is, as the desktop colours it: calm under 60%,
/// warm to 85%, hot above.
public enum MonitorLevel: String, Sendable, Equatable {
    case calm, warm, hot, unavailable

    public static func of(_ percent: Double?) -> MonitorLevel {
        guard let percent else { return .unavailable }
        return percent >= 85 ? .hot : percent >= 60 ? .warm : .calm
    }
}

/// The desktop's numbers, said the same way (`en-US`, its own rules).
public enum MonitorFormat {
    private static let units = ["B", "KB", "MB", "GB", "TB", "PB"]

    /// Base 1024, one decimal past bytes: "1.5 GB", "0 B", "—" for nil.
    public static func bytes(_ value: Double?) -> String {
        guard let value else { return "—" }
        guard value > 0 else { return "0 B" }
        let power = min(units.count - 1, max(0, Int((log(value) / log(1024)).rounded(.down))))
        let scaled = value / pow(1024, Double(power))
        return "\(number(scaled, decimals: power == 0 ? 0 : 1)) \(units[power])"
    }

    public static func rate(_ value: Double?) -> String { value == nil ? "—" : "\(bytes(value))/s" }

    /// One decimal: "26.1%".
    public static func percent(_ value: Double?) -> String {
        guard let value else { return "—" }
        return "\(fixed(value, 1))%"
    }

    public static func temperature(_ value: Double?) -> String { value.map { "\(fixed($0, 0)) °C" } ?? "—" }
    public static func watts(_ value: Double?) -> String { value.map { "\(fixed($0, 1)) W" } ?? "—" }
    public static func gigahertz(_ mhz: Double?) -> String { mhz.map { "\(fixed($0 / 1000, 2)) GHz" } ?? "—" }

    /// `places` decimals as JavaScript's `toFixed` gives them: halves up,
    /// from the number as written (26.05 is "26.1"), not its binary value.
    static func fixed(_ value: Double, _ places: Int) -> String {
        guard value.isFinite, var decimal = Decimal(string: "\(value)", locale: Locale(identifier: "en_US_POSIX")) else { return "—" }
        var rounded = Decimal()
        NSDecimalRound(&rounded, &decimal, places, .plain)
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.minimumFractionDigits = places
        formatter.maximumFractionDigits = places
        formatter.minimumIntegerDigits = 1
        return formatter.string(from: rounded as NSDecimalNumber) ?? "\(value)"
    }

    /// "3d 4h" past a day, else "4h 12m".
    public static func uptime(_ seconds: Double) -> String {
        let total = Int(max(0, seconds))
        let days = total / 86_400, hours = total / 3600 % 24, minutes = total / 60 % 60
        return days > 0 ? "\(days)d \(hours)h" : "\(hours)h \(minutes)m"
    }

    /// Grouped thousands: "1,234".
    public static func count(_ value: Int) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.numberStyle = .decimal
        return formatter.string(from: NSNumber(value: value)) ?? "\(value)"
    }

    /// At most `decimals` places, trailing zeros dropped, thousands grouped.
    static func number(_ value: Double, decimals: Int) -> String {
        var decimal = Decimal(string: "\(value)", locale: Locale(identifier: "en_US_POSIX")) ?? Decimal(value)
        var rounded = Decimal()
        NSDecimalRound(&rounded, &decimal, decimals, .plain)
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.numberStyle = .decimal
        formatter.minimumFractionDigits = 0
        formatter.maximumFractionDigits = decimals
        formatter.roundingMode = .halfUp
        return formatter.string(from: rounded as NSDecimalNumber) ?? "\(value)"
    }

    public static func share(_ part: Double?, of total: Double?) -> Double? {
        guard let part, let total, total > 0 else { return nil }
        return part / total * 100
    }
}

/// The process list as the desktop keeps it: each process's CPU over the
/// last minute, filtered by name, user, state or PID, and sorted by a
/// column; the order moves at most every five seconds so a row can be
/// read before it jumps.
public struct ProcessTable: Equatable, Sendable {
    public enum Column: String, CaseIterable, Sendable {
        case pid, name, user, cpu, memory, state, threads
    }

    public struct Sort: Equatable, Sendable {
        public var column: Column
        public var descending: Bool

        public init(column: Column, descending: Bool) {
            self.column = column
            self.descending = descending
        }

        /// The desktop's: busiest first.
        public static let standard = Sort(column: .cpu, descending: true)

        /// A tap on `column`: the same one turns it round; another starts
        /// with the biggest numbers or A to Z.
        public func choosing(_ column: Column) -> Sort {
            if column == self.column { return Sort(column: column, descending: !descending) }
            switch column {
            case .cpu, .memory, .threads: return Sort(column: column, descending: true)
            case .pid, .name, .user, .state: return Sort(column: column, descending: false)
            }
        }
    }

    public struct Row: Equatable, Sendable {
        public var process: SystemMonitorSample.Process
        /// Oldest first, at most `historyLength`.
        public var cpuHistory: [Double?]
    }

    public static let historyLength = 60
    /// How long an order holds while the numbers under it change.
    public static let reorderInterval: Double = 5

    /// Each process's CPU by PID, oldest first.
    public private(set) var histories: [Int: [Double?]] = [:]
    /// The PIDs in the order shown last, and when it was worked out.
    public private(set) var order: [Int] = []
    public private(set) var orderedAt: Double = -.infinity
    private var orderedBy: Sort?
    private var orderedFor: String?
    private var lastSample: Double?

    public init() {}

    /// This table's histories with the order `previous` showed: the screen
    /// keeps its order while the feed keeps the histories.
    public func continuing(_ previous: ProcessTable) -> ProcessTable {
        var table = self
        table.order = previous.order
        table.orderedAt = previous.orderedAt
        table.orderedBy = previous.orderedBy
        table.orderedFor = previous.orderedFor
        return table
    }

    /// Adds `sample`'s readings to each process's history, once per sample.
    public mutating func record(_ sample: SystemMonitorSample) {
        guard lastSample != sample.sampledAt else { return }
        lastSample = sample.sampledAt
        let items = sample.processes?.items ?? []
        var next: [Int: [Double?]] = [:]
        for process in items {
            var history = histories[process.pid] ?? []
            history.append(process.cpuPercent)
            if history.count > Self.historyLength { history.removeFirst(history.count - Self.historyLength) }
            next[process.pid] = history
        }
        histories = next
    }

    /// The rows to show at `now` (seconds): the processes `filter` matches,
    /// in `sort`'s order when it or the filter changed or the last order
    /// is five seconds old, else in the order shown, newcomers last.
    public mutating func rows(_ items: [SystemMonitorSample.Process], filter: String, sort: Sort, now: Double) -> [Row] {
        let shown = Self.matching(filter, in: items)
        let byPid = Dictionary(shown.map { ($0.pid, $0) }, uniquingKeysWith: { first, _ in first })
        if orderedBy != sort || orderedFor != filter || now - orderedAt >= Self.reorderInterval || now < orderedAt {
            order = Self.sorted(shown, by: sort).map(\.pid)
            orderedAt = now
            orderedBy = sort
            orderedFor = filter
        } else {
            let kept = order.filter { byPid[$0] != nil }
            let known = Set(kept)
            order = kept + Self.sorted(shown.filter { !known.contains($0.pid) }, by: sort).map(\.pid)
        }
        return order.compactMap { pid in byPid[pid].map { Row(process: $0, cpuHistory: histories[pid] ?? [$0.cpuPercent]) } }
    }

    /// Every word of `filter` in the name, user, state or PID.
    public static func matching(_ filter: String, in items: [SystemMonitorSample.Process]) -> [SystemMonitorSample.Process] {
        let words = filter.split(whereSeparator: \.isWhitespace).map(String.init)
        guard !words.isEmpty else { return items }
        return items.filter { process in
            let haystack = [process.name, process.user ?? "", process.state ?? "", String(process.pid)].joined(separator: " ")
            return words.allSatisfy { haystack.range(of: $0, options: [.caseInsensitive, .diacriticInsensitive]) != nil }
        }
    }

    /// Unknown values last whichever way; PID breaks ties.
    public static func sorted(_ items: [SystemMonitorSample.Process], by sort: Sort) -> [SystemMonitorSample.Process] {
        func compare<T: Comparable>(_ a: T?, _ b: T?) -> Bool? {
            switch (a, b) {
            case (nil, nil): return nil
            case (nil, _): return false
            case (_, nil): return true
            case let (a?, b?): return a == b ? nil : (sort.descending ? a > b : a < b)
            }
        }
        return items.sorted { a, b in
            let decided: Bool?
            switch sort.column {
            case .pid: decided = compare(a.pid, b.pid)
            case .name: decided = compare(a.name.lowercased(), b.name.lowercased())
            case .user: decided = compare(a.user?.lowercased(), b.user?.lowercased())
            case .cpu: decided = compare(a.cpuPercent, b.cpuPercent)
            case .memory: decided = compare(a.memoryBytes, b.memoryBytes)
            case .state: decided = compare(a.state, b.state)
            case .threads: decided = compare(a.threads, b.threads)
            }
            return decided ?? (a.pid < b.pid)
        }
    }
}
