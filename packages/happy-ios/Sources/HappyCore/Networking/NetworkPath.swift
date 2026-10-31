import Foundation
import Network

/// Whether this phone has a way out at all, as the system says
/// (`NWPathMonitor`): with none, headers say "Waiting for network…" rather
/// than "Connecting…", as Telegram's do. One monitor for the app; watchers
/// hear on the main queue.
public final class NetworkPath: @unchecked Sendable {
    public static let shared = NetworkPath()

    private let monitor = NWPathMonitor()
    private let lock = NSLock()
    private var satisfied = true
    private var watchers: [UUID: @Sendable (Bool) -> Void] = [:]
    #if DEBUG
    /// Tests: what the path is said to be, whatever it is.
    private var forced: Bool?
    #endif

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in self?.update(path.status == .satisfied) }
        monitor.start(queue: DispatchQueue(label: "engineering.happy.network-path", qos: .utility))
    }

    /// Whether there is a way out; true until the system says otherwise.
    public var isSatisfied: Bool {
        lock.lock(); defer { lock.unlock() }
        #if DEBUG
        if let forced { return forced }
        #endif
        return satisfied
    }

    private func update(_ value: Bool) {
        lock.lock()
        let changed = satisfied != value
        satisfied = value
        let shown = Self.shown(value, self)
        let watchers = Array(watchers.values)
        lock.unlock()
        guard changed else { return }
        DispatchQueue.main.async { for watch in watchers { watch(shown) } }
    }

    private static func shown(_ value: Bool, _ path: NetworkPath) -> Bool {
        #if DEBUG
        if let forced = path.forced { return forced }
        #endif
        return value
    }

    /// Calls `watch` on the main queue whenever the path comes or goes;
    /// stops when the returned token is cancelled.
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
    #endif
}

public final class NetworkPathWatch: @unchecked Sendable {
    private var cancel: (() -> Void)?
    init(_ cancel: @escaping () -> Void) { self.cancel = cancel }
    public func invalidate() { cancel?(); cancel = nil }
    deinit { cancel?() }
}
