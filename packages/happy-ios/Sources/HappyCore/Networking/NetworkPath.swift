import Foundation
#if canImport(Network)
import Network
#endif

/// Whether this phone has a way out at all, as the system says
/// (`NWPathMonitor`): with none, headers say "Waiting for network…" rather
/// than "Connecting…", as Telegram's do. One monitor for the app; watchers
/// hear on the main queue, when the path comes or goes and when it moves
/// to another interface (`moves`).
public final class NetworkPath: @unchecked Sendable {
    public static let shared = NetworkPath()

    #if canImport(Network)
    private let monitor = NWPathMonitor()
    #endif
    private let lock = NSLock()
    private var satisfied = true
    private var latest = NetworkPathDetails(satisfied: true)
    /// The interface the system last sent on ("en0", "pdp_ip0"), kept
    /// while there is none: coming back on another one is a move too.
    private var route: String?
    private var moved = 0
    private var watchers: [UUID: @Sendable (Bool) -> Void] = [:]
    #if DEBUG
    /// Tests: what the path is said to be, whatever it is.
    private var forced: Bool?
    #endif

    private init() {
        #if canImport(Network)
        monitor.pathUpdateHandler = { [weak self] path in
            self?.describe(path)
            self?.update(path.status == .satisfied, route: path.status == .satisfied ? path.availableInterfaces.first?.name : nil)
        }
        monitor.start(queue: DispatchQueue(label: "engineering.happy.network-path", qos: .utility))
        #endif
    }

    /// Whether there is a way out; true until the system says otherwise.
    public var isSatisfied: Bool {
        lock.lock(); defer { lock.unlock() }
        #if DEBUG
        if let forced { return forced }
        #endif
        return satisfied
    }

    /// How many times the way out moved to another interface (Wi-Fi to
    /// cellular, one Wi-Fi to another): what was open went out the old
    /// way, and may hang there with nothing said.
    public var moves: Int {
        lock.lock(); defer { lock.unlock() }
        return moved
    }

    /// The way out as the system last described it: the interface, and
    /// whether it is expensive (cellular, a hotspot) or constrained (Low
    /// Data Mode).
    public var details: NetworkPathDetails {
        lock.lock(); defer { lock.unlock() }
        var value = latest
        #if DEBUG
        if let forced { value.satisfied = forced }
        #endif
        return value
    }

    #if canImport(Network)
    private func describe(_ path: NWPath) {
        let interface: NetworkPathDetails.Interface = if path.status != .satisfied { .none }
            else if path.usesInterfaceType(.wifi) { .wifi }
            else if path.usesInterfaceType(.cellular) { .cellular }
            else if path.usesInterfaceType(.wiredEthernet) { .wired }
            else if path.usesInterfaceType(.loopback) { .loopback }
            else { .other }
        let value = NetworkPathDetails(satisfied: path.status == .satisfied, interface: interface, expensive: path.isExpensive, constrained: path.isConstrained)
        lock.lock(); latest = value; lock.unlock()
    }
    #endif

    private func update(_ value: Bool, route: String?) {
        lock.lock()
        let moves = Self.moves(from: self.route, to: route)
        if moves { moved += 1 }
        if let route { self.route = route }
        let changed = satisfied != value || moves
        satisfied = value
        let shown = Self.shown(value, self)
        let watchers = Array(watchers.values)
        lock.unlock()
        guard changed else { return }
        DispatchQueue.main.async { for watch in watchers { watch(shown) } }
    }

    /// Whether going out on `new` after `old` is a move: another interface,
    /// not the first one heard nor none at all.
    static func moves(from old: String?, to new: String?) -> Bool {
        guard let old, let new else { return false }
        return old != new
    }

    private static func shown(_ value: Bool, _ path: NetworkPath) -> Bool {
        #if DEBUG
        if let forced = path.forced { return forced }
        #endif
        return value
    }

    /// Calls `watch` on the main queue whenever the path comes, goes or
    /// moves; stops when the returned token is cancelled.
    public func watch(_ watch: @escaping @Sendable (Bool) -> Void) -> NetworkPathWatch {
        let id = UUID()
        lock.lock()
        watchers[id] = watch
        lock.unlock()
        return NetworkPathWatch { [weak self] in
            guard let self else { return }
            self.lock.lock()
            self.watchers[id] = nil
            self.lock.unlock()
        }
    }

    #if DEBUG
    /// Tests: the path as given (nil: as the system says), told to watchers.
    public func force(_ value: Bool?) {
        lock.lock()
        forced = value
        let shown = value ?? satisfied
        let watchers = Array(watchers.values)
        lock.unlock()
        DispatchQueue.main.async { for watch in watchers { watch(shown) } }
    }

    /// Tests: the path moved to another interface, told to watchers.
    public func forceMove() {
        lock.lock()
        moved += 1
        let shown = Self.shown(satisfied, self)
        let watchers = Array(watchers.values)
        lock.unlock()
        DispatchQueue.main.async { for watch in watchers { watch(shown) } }
    }
    #endif
}

public struct NetworkPathDetails: Equatable, Sendable {
    public enum Interface: String, Sendable {
        case wifi = "Wi-Fi", cellular = "Cellular", wired = "Ethernet", loopback = "Loopback", other = "Other", none = "None"
    }
    public var satisfied: Bool
    public var interface: Interface = .other
    public var expensive = false
    public var constrained = false

    public init(satisfied: Bool, interface: Interface = .other, expensive: Bool = false, constrained: Bool = false) {
        self.satisfied = satisfied; self.interface = interface; self.expensive = expensive; self.constrained = constrained
    }

    /// "Wi-Fi", "Cellular · expensive · Low Data Mode", "No network".
    public var text: String {
        guard satisfied else { return "No network" }
        var parts = [interface.rawValue]
        if expensive { parts.append("expensive") }
        if constrained { parts.append("Low Data Mode") }
        return parts.joined(separator: " · ")
    }
}

public final class NetworkPathWatch: @unchecked Sendable {
    private var cancel: (() -> Void)?
    init(_ cancel: @escaping () -> Void) { self.cancel = cancel }
    public func invalidate() { cancel?(); cancel = nil }
    deinit { cancel?() }
}
