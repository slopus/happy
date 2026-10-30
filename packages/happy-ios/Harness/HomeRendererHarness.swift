#if (DEBUG || HAPPY_FIXTURES) && canImport(UIKit)
import HappyCore
import HappyStore
import HappyWire
@testable import HappyUI
import UIKit
import UltraView

private struct HomeHarnessOffline: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}
private struct HomeHarnessNoSocket: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// Drives the real Home screen with the existing seeded account, including
/// its dock, Settings navigation and live store observation. No live account.
@MainActor
final class HomeRendererHarness {
    private var account: AccountController?
    private var archiveProbe: HomeArchiveProbe?
    private var qaProbe: ChatUltraQAProbe?
    init(window: UIWindow, arguments: [String]) {
        func option(_ name: String) -> String? {
            arguments.firstIndex(of: name).flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil }
        }
        let renderer = HomeListRenderer(rawValue: option("-renderer") ?? "UITableView") ?? .tableView
        let restoreRenderer = option("-renderer") == "stored"
        let grouping = option("-grouping") ?? "flat"
        let sessionCount = Int(option("-sessionCount") ?? "0") ?? 0
        let archiveCount = Int(option("-archiveCount") ?? "0") ?? 0
        Task {
            let controller = AccountController(serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/home-renderer-harness", credentialStore: InMemoryCredentialStore(), storeDirectory: nil, rnServerImport: { .confirmed(ServerConfig.defaultServerURL) }, localSettingsFactory: { UserDefaultsStore(suiteName: "home-renderer-harness.\($0)") }, transport: HomeHarnessOffline(), connector: HomeHarnessNoSocket())
            do {
                try await controller.signIn(Credentials(token: "home-harness", secret: Data(repeating: 19, count: 32)))
                guard let session = controller.session else { fatalError("Home harness missing session") }
                self.account = controller
                if !restoreRenderer {
                    controller.localSettings.homeListRenderer = renderer
                    controller.localSettings.chatListRenderer = arguments.contains("-chatUltraList") ? .ultraList : .collectionView
                }
                let store = session.store
                try await Task.detached {
                    try SeededAccount.seed(store)
                    if archiveCount > 0, let template = try store.sessions().first {
                        try store.upsertSessions((0..<archiveCount).map { index in
                            var row = template
                            row.id = "archive-\(index)"; row.active = false
                            var metadata = row.metadata?.objectValue ?? [:]
                            metadata["summary"] = .object(["text": .string("Archived fixture \(index)")])
                            row.metadata = .object(metadata)
                            return row
                        })
                    }
                    if sessionCount > 0, let template = try store.sessions().first {
                        try store.upsertSessions((0..<sessionCount).map { index in
                            var row = template
                            row.id = "stress-\(index)"
                            row.createdAt += Int64(index)
                            var metadata = row.metadata?.objectValue ?? [:]
                            metadata["lastMeaningfulMessageAt"] = .number(Double(SeededAccount.base + Int64(index)))
                            metadata["summary"] = .object(["text": .string("Session \(index)")])
                            row.metadata = .object(metadata)
                            return row
                        })
                    }
                    try store.addPendingSettings(["sessionListGrouping": .string(grouping), "hideInactiveSessions": .bool(archiveCount > 0)])
                }.value
                let context = AppContext(account: controller, variant: .development, version: "home-harness")
                let home = LegacyHomeViewController(context: context, session: session)
                let navigation = UINavigationController(rootViewController: home)
                AppCoordinator.applyAppearance(to: navigation.navigationBar)
                let shell = TabletShellViewController(context: context, detail: navigation)
                window.rootViewController = shell
                if arguments.contains("-qaProbe"), let window = window as? HarnessWindow {
                    qaProbe = ChatUltraQAProbe(window: window, chat: nil)
                }
                shell.rootDidChange()
                if archiveCount > 0, let window = window as? HarnessWindow {
                    archiveProbe = HomeArchiveProbe(window: window, snapshots: store.homeSnapshots())
                }
            } catch { fatalError("Home harness: \(error)") }
        }
    }
}

/// App-clock timing of each archive toggle, from the touch's `.ended` event
/// as the window received it to the display frame that first shows the
/// change, with the stages between. The UI test's polling and XCTest's idle
/// waits are outside every interval.
///
/// - feed: a home snapshot with the new setting reached a subscriber;
/// - home: Home applied the derived update (`ApplyPerf` site `home`);
/// - list: the list applied its rows (`home list`);
/// - label: a frame shows the toggle's new words;
/// - mount: a frame holds an archived row view (opening);
/// - ms: a frame shows an archived row drawn and on screen (opening), or
///   one of the rows shown at the release fading or gone (closing).
///
/// Frames are display-link callbacks, stamped with the link's target time,
/// the frame the observed state is on screen by. Geometry and opacity are
/// read from presentation layers. -1 is a stage that never happened.
@MainActor
final class HomeArchiveProbe: NSObject {
    private struct Sample: Encodable {
        var opening: Bool
        var ms = -1.0, event = -1.0, floor = -1.0, feed = -1.0, home = -1.0, listStart = -1.0, list = -1.0, label = -1.0, mount = -1.0
        var beforeTouchTarget = -1.0, commitTarget = -1.0
        var frames: [Frame] = []
    }
    private struct Frame: Encodable {
        var callback: Double
        var timestamp: Double
        var target: Double
        var opacity: Float?
        var floorVisible: Bool
        var mounted: Int
        var readyOnScreen: Int
        var onScreen: Int
    }
    private struct ArchiveRow {
        var view: UIView
        var opacity: Float
        var ready: Bool
        var onScreen: Bool
        var visible: Bool { ready && onScreen && opacity > 0.01 }
    }
    private weak var window: HarnessWindow?
    private let element = UILabel(frame: CGRect(x: 0, y: 0, width: 2, height: 2))
    private let touchElement = UILabel(frame: CGRect(x: 2, y: 0, width: 2, height: 2))
    private let idleElement = ProbeElement(frame: CGRect(x: 4, y: 0, width: 2, height: 2))
    private var touchTraces: [String] = []
    /// A trivial colour change in the same touch-up event provides a system
    /// presentation floor. Its pixels can be compared with archive pixels in
    /// a simulator recording; it does not replace the original timing endpoint.
    private let latencyFloor = UIView()
    private var floorGreen = false
    private var floorColor: UIColor { floorGreen ? UIColor(red: 0, green: 1, blue: 0, alpha: 1) : UIColor(red: 1, green: 0, blue: 1, alpha: 1) }
    private var link: CADisplayLink?
    private var latestTarget: CFTimeInterval = 0
    private var tracking = false
    private var opening = false
    private var started: CFTimeInterval = 0
    private var current: Sample?
    /// Closing: the archived rows on screen at the release, and their
    /// opacity then.
    private var shown: [ObjectIdentifier: (view: UIView, opacity: Float)] = [:]
    private var samples: [Sample] = []
    private var feedTask: Task<Void, Never>?
    private let archivedPrefixes: [String]?
    var report: Data { (try? JSONEncoder().encode(samples)) ?? Data() }

    init(window: HarnessWindow, snapshots: AsyncStream<LegacyHomeSnapshot>, archivedPrefixes: [String]? = nil) {
        self.window = window
        self.archivedPrefixes = archivedPrefixes
        super.init()
        element.isAccessibilityElement = true
        element.accessibilityIdentifier = "home.archive-probe"
        element.accessibilityLabel = "Archive frame timing"
        element.accessibilityValue = "[]"
        window.addSubview(element)
        latencyFloor.frame = CGRect(x: 8, y: window.safeAreaInsets.top + 2, width: 8, height: 8)
        latencyFloor.isUserInteractionEnabled = false
        latencyFloor.backgroundColor = floorColor
        window.addSubview(latencyFloor)
        touchElement.isAccessibilityElement = true
        touchElement.accessibilityIdentifier = "home.archive-touch-events"
        window.addSubview(touchElement)
        idleElement.isAccessibilityElement = true
        idleElement.accessibilityIdentifier = "home.archive-scroll-idle"
        idleElement.read = { [weak window] in
            @MainActor func find(_ view: UIView) -> UltraListView? {
                if let list = view as? UltraListView { return list }
                for child in view.subviews { if let list = find(child) { return list } }
                return nil
            }
            guard let window, let list = find(window) else { return "loading" }
            return list.isScrollFlightActive || list.isDecelerating || list.isDragging || list.isTracking ? "moving" : "idle"
        }
        window.addSubview(idleElement)
        // Start before a finger arrives: a display-link created only on
        // release can itself miss the next frame and cannot identify the
        // upcoming target vsync at the time the list commits.
        let link = CADisplayLink(target: self, selector: #selector(frame(_:)))
        self.link = link; link.add(to: .main, forMode: .common)
        window.onTouch = { [weak self] in self?.touch($0) }
        ApplyPerf.onApply = { [weak self] site, _ in self?.applied(site, at: CACurrentMediaTime()) }
        ApplyPerf.onWillApply = { [weak self] site in
            if site == .homeList { self?.stage(\.listStart, at: CACurrentMediaTime()) }
        }
        feedTask = Task.detached { [weak self] in
            var hidden: Bool?
            for await snapshot in snapshots {
                let now = CACurrentMediaTime()
                let next = AccountSettings(snapshot.settings).hideArchivedSessions
                defer { hidden = next }
                guard let hidden, hidden != next else { continue }
                await self?.stage(\.feed, at: now)
            }
        }
    }

    private func stage(_ key: WritableKeyPath<Sample, Double>, at time: CFTimeInterval) {
        guard var sample = current, sample[keyPath: key] < 0, time >= started else { return }
        sample[keyPath: key] = (time - started) * 1000; current = sample
    }

    private func applied(_ site: ApplySite, at time: CFTimeInterval) {
        switch site {
        case .home: stage(\.home, at: time)
        case .homeList:
            stage(\.list, at: time)
            if current != nil, current?.commitTarget == -1, latestTarget > 0 {
                current?.commitTarget = (latestTarget - started) * 1000
            }
        default: break
        }
    }

    private func touch(_ touch: UITouch) {
        if touch.phase == .began || touch.phase == .ended || touch.phase == .cancelled {
            var chain: [String] = []
            var target = touch.view
            while let view = target {
                let label = ["Show archived", "Hide archived"].contains(view.accessibilityLabel ?? "") ? view.accessibilityLabel! : ""
                chain.append("\(NSStringFromClass(type(of: view))) \(label) \(view.convert(view.bounds, to: window))")
                target = view.superview
            }
            touchTraces.append("\(touch.phase.rawValue): " + chain.joined(separator: " > "))
            if touchTraces.count > 12 { touchTraces.removeFirst() }
            touchElement.accessibilityValue = touchTraces.joined(separator: "; ")
        }
        if touch.phase == .began {
            tracking = false
            var target = touch.view
            while let view = target {
                if let label = view.accessibilityLabel, ["Show archived", "Hide archived"].contains(label) {
                    opening = label == "Show archived"; tracking = true; break
                }
                target = view.superview
            }
        }
        guard tracking, touch.phase == .ended, let window else { return }
        tracking = false; started = touch.timestamp
        current = Sample(opening: opening)
        if latestTarget > 0 { current?.beforeTouchTarget = (latestTarget - started) * 1000 }
        stage(\.event, at: CACurrentMediaTime())
        floorGreen.toggle()
        latencyFloor.backgroundColor = floorColor
        shown = [:]
        if !opening {
            for row in archivedRows(in: window, inherited: 1) where row.visible { shown[ObjectIdentifier(row.view)] = (row.view, row.opacity) }
        }
    }

    /// Archived row views drawn and on screen, with their opacity as shown.
    private func archivedRows(in view: UIView, inherited: Float) -> [ArchiveRow] {
        guard !view.isHidden, let window else { return [] }
        let layer = view.layer.presentation() ?? view.layer
        let opacity = inherited * layer.opacity
        let isRow = view is SessionRowCell || view is ProjectChatCell || view is ListRowView
        let archived = isRow && (view.accessibilityLabel.map { label in
            archivedPrefixes.map { $0.contains { label.hasPrefix($0 + ",") } } ?? label.hasPrefix("Archived fixture")
        } ?? false)
        if archived {
            let ready = (view as? ListRowView)?.isDisplayReady ?? true
            let screen = window.layer.presentation() ?? window.layer
            let onScreen = layer.convert(layer.bounds, to: screen).intersects(screen.bounds)
            return [ArchiveRow(view: view, opacity: opacity, ready: ready, onScreen: onScreen)]
        }
        return view.subviews.flatMap { archivedRows(in: $0, inherited: opacity) }
    }

    private func showsLabel(_ label: String, in view: UIView) -> Bool {
        view.accessibilityLabel == label || view.subviews.contains { showsLabel(label, in: $0) }
    }

    @objc private func frame(_ link: CADisplayLink) {
        latestTarget = link.targetTimestamp
        guard let window, var sample = current else { return }
        let elapsed = (link.targetTimestamp - started) * 1000
        let mounted = archivedRows(in: window, inherited: 1)
        let visible = mounted.filter(\.visible)
        let floorLayer = latencyFloor.layer.presentation() ?? latencyFloor.layer
        let floorVisible = floorLayer.backgroundColor.map { UIColor(cgColor: $0).isEqual(floorColor) } ?? false
        // A queued display callback may run after our handler while still
        // carrying a target from before it. Newly mounted layers also fall
        // back to their model opacity until their first commit. Neither is
        // evidence that the touch's change was presented.
        let eligibleFrame = floorVisible && elapsed >= max(sample.event, sample.list)
        if sample.floor < 0, eligibleFrame { sample.floor = elapsed }
        if sample.frames.count < 120 {
            sample.frames.append(Frame(callback: (CACurrentMediaTime() - started) * 1000, timestamp: (link.timestamp - started) * 1000, target: elapsed, opacity: mounted.filter { $0.ready && $0.onScreen }.map(\.opacity).min(), floorVisible: floorVisible, mounted: mounted.count, readyOnScreen: mounted.filter { $0.ready && $0.onScreen }.count, onScreen: mounted.filter(\.onScreen).count))
        }
        guard eligibleFrame else { current = sample; return }
        if sample.label < 0, showsLabel(opening ? "Hide archived" : "Show archived", in: window) { sample.label = elapsed }
        let changed: Bool
        if opening {
            if sample.mount < 0, !mounted.isEmpty { sample.mount = elapsed }
            changed = !visible.isEmpty
        } else {
            let now = Dictionary(visible.map { (ObjectIdentifier($0.view), $0.opacity) }, uniquingKeysWith: min)
            changed = shown.contains { id, before in (now[id] ?? 0) < before.opacity * 0.99 }
        }
        current = sample
        guard changed || elapsed > 3000 else { return }
        if changed { sample.ms = elapsed }
        samples.append(sample); current = nil
        element.accessibilityValue = String(data: try! JSONEncoder().encode(samples), encoding: .utf8)
    }
}
#endif
