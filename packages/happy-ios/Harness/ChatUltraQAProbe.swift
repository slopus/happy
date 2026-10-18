#if (DEBUG || HAPPY_FIXTURES) && canImport(UIKit)
import HappyCore
@testable import HappyUI
import UIKit
import UltraView

/// QA only (`-qaProbe`): the chat list's cadence and geometry on every
/// display frame from launch, for device recordings of either renderer.
///
/// Each frame records the display link's timestamps, the list's motion
/// state, the model and presentation scroll offsets, the dock's presented
/// top, and the rows on screen as presented: how many are mounted, drawn
/// and blank, the common (rigid) movement of rows seen in both frames and
/// the largest row moving differently from it, the gap between the newest
/// message and the dock, and the row under the last tap.
///
/// Frames group into action windows: a window opens on a touch, list
/// motion, a chat list apply or a moving dock, and closes after half a
/// second with none. A closed window reports its frame gaps against the
/// display period (p50/p95/p99/max, missed frames, hitches), main-thread
/// turns, blank-row frames and drift. Frames go to
/// `Documents/qa/<run>-frames.csv` and windows to `<run>-windows.json`,
/// written off main after each window closes.
///
/// Display-link callbacks run on the main thread: a gap is a frame the main
/// thread missed, not proof the render server missed one (render-server
/// scrolling continues without main). The Animation Hitches trace is the
/// authority for composited frames.
///
/// Two elements report to UI tests: `chat-ultra-qa` (renderer, mount state,
/// windows) and `chat-ultra-qa-controls` (on-screen rows, their tap and
/// long-press targets and native controls, in window points). Reading
/// either serializes accessibility in the app, so tests read them only
/// when a window has closed.
@MainActor
final class ChatUltraQAProbe: NSObject {
    private struct Frame {
        var time: Double
        var target: Double
        var callback: Double
        var flags: Int
        var offset: Double
        var presented: Double
        var dockY: Double
        var loaded: Int
        var onScreen: Int
        var ready: Int
        var blank: Int
        var uncovered: Double
        var rigid: Double
        var deviation: Double
        var newestGap: Double
        var touchRowY: Double
        var turn: Double
    }

    private struct Flags {
        static let finger = 1, tracking = 2, dragging = 4, decelerating = 8, flight = 16, apply = 32, dock = 64, motion = 128
    }

    private struct Window: Encodable {
        var index: Int
        var start: Double
        var seconds: Double
        var frames: Int
        var expectedMs: Double
        var gapP50Ms: Double
        var gapP95Ms: Double
        var gapP99Ms: Double
        var gapMaxMs: Double
        var missedFrames: Int
        var hitches: Int
        var callbackLateP99Ms: Double
        var callbackLateMaxMs: Double
        var turnMaxMs: Double
        var turnsOverFrame: Int
        var applies: Int
        var touches: Int
        var blankFrames: Int
        var blankMax: Int
        var notReadyOnScreenFrames: Int
        var uncoveredMax: Double
        var nonRigidMax: Double
        var restDriftMax: Double
        var newestGapRange: Double
        var touchRowDriftMax: Double
        var dockTravel: Double
        var offsetTravel: Double
        var kinds: [String]
    }

    private weak var window: HarnessWindow?
    private weak var chat: UIViewController?
    private let summary = ProbeElement(frame: CGRect(x: 6, y: 0, width: 2, height: 2))
    private let controls = ProbeElement(frame: CGRect(x: 8, y: 0, width: 2, height: 2))
    private var link: CADisplayLink?
    private let run: String
    private let directory: URL?
    private let writer = DispatchQueue(label: "happy.chat-ultra-qa.writer", qos: .utility)

    private var frames: [Frame] = []
    private var written = 0
    private var windows: [Window] = []
    private var windowStart: Int?
    private var lastActive = -1
    private var touchesInWindow = 0
    private var appliesInWindow = 0
    private var fingerDown = false
    private var appliedSinceFrame = false
    private var turnSinceFrame = 0.0
    private var previousRows: [String: CGFloat] = [:]
    private var previousDockY: Double?
    private var previousPresented: Double?
    private var touchRow: String?
    private var touchRowStartY: Double?

    init(window: HarnessWindow, chat: UIViewController) {
        self.window = window
        self.chat = chat
        let arguments = ProcessInfo.processInfo.arguments
        let named = arguments.firstIndex(of: "-qaRun").flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil }
        run = named ?? "run-\(Int(Date().timeIntervalSince1970))"
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?.appendingPathComponent("qa")
        if let documents { try? FileManager.default.createDirectory(at: documents, withIntermediateDirectories: true) }
        directory = documents
        super.init()
        for (element, name) in [(summary, "chat-ultra-qa"), (controls, "chat-ultra-qa-controls")] {
            element.isAccessibilityElement = true
            element.accessibilityIdentifier = name
            element.isUserInteractionEnabled = false
            element.alpha = 0.02
            window.addSubview(element)
        }
        summary.read = { [weak self] in self?.summaryReport() ?? "{}" }
        controls.read = { [weak self] in self?.controlsReport() ?? "{}" }
        let previous = window.onTouch
        window.onTouch = { [weak self] touch in
            previous?(touch)
            self?.touched(touch)
        }
        ApplyPerf.onApply = { [weak self] site, _ in
            if site == .chatList { self?.appliedSinceFrame = true }
        }
        MainThreadMonitor.shared.onTurn = { [weak self] turn in
            guard let self else { return }
            self.turnSinceFrame = max(self.turnSinceFrame, turn.milliseconds)
        }
        MainThreadMonitor.shared.start(phase: "qa")
        if let directory {
            let header = "time,target,callback,flags,offset,presented,dockY,loaded,onScreen,ready,blank,uncovered,rigid,deviation,newestGap,touchRowY,turn\n"
            try? header.write(to: directory.appendingPathComponent("\(run)-frames.csv"), atomically: true, encoding: .utf8)
        }
        let link = CADisplayLink(target: self, selector: #selector(frame(_:)))
        link.add(to: .main, forMode: .common)
        self.link = link
        NotificationCenter.default.addObserver(self, selector: #selector(flush), name: UIApplication.willResignActiveNotification, object: nil)
    }

    // MARK: The list

    private weak var cachedList: ChatListView?
    private weak var cachedDock: ChatDockView?

    private var list: ChatListView? {
        if let cachedList, cachedList.window != nil { return cachedList }
        cachedList = chat.flatMap { Self.find(ChatListView.self, in: $0.view) }
        return cachedList
    }

    private var dock: ChatDockView? {
        if let cachedDock, cachedDock.window != nil { return cachedDock }
        cachedDock = chat.flatMap { Self.find(ChatDockView.self, in: $0.view) }
        return cachedDock
    }

    private static func find<T: UIView>(_ type: T.Type, in view: UIView) -> T? {
        for child in view.subviews {
            if let match = child as? T { return match }
            if let match = find(type, in: child) { return match }
        }
        return nil
    }

    private static func all<T: UIView>(_ type: T.Type, in view: UIView, into found: inout [T]) {
        for child in view.subviews where !child.isHidden {
            if let match = child as? T { found.append(match) }
            all(type, in: child, into: &found)
        }
    }

    /// The row views the list shows, with the identity the adapter gives
    /// them (`chat:message:<id>`), for either renderer.
    private func rowViews(_ list: ChatListView) -> [(identity: String, view: UIView, ready: Bool)] {
        if let ultra = list.ultra {
            return ultra.list.loadedItemViews.map { view -> (identity: String, view: UIView, ready: Bool) in
                let identity = (view as? ChatUltraRowView)?.row.identity ?? "chat:older-end"
                return (identity: identity, view: view, ready: view.isDisplayReady)
            }
        }
        return list.collectionView.visibleCells.compactMap { cell -> (identity: String, view: UIView, ready: Bool)? in
            guard let cell = cell as? ChatRowCell, let plan = cell.plan else { return nil }
            return (identity: "chat:message:\(plan.id)", view: cell, ready: true)
        }
    }

    private func presentedFrame(_ view: UIView, in screen: CALayer) -> CGRect {
        let layer = view.layer.presentation() ?? view.layer
        return layer.convert(layer.bounds, to: screen)
    }

    // MARK: Frames

    private func touched(_ touch: UITouch) {
        switch touch.phase {
        case .began:
            fingerDown = true
            touchesInWindow += 1
        case .ended, .cancelled:
            fingerDown = false
            // The row under the finger as it lifts: a tap that opens or
            // closes it should leave it where it is.
            guard let window, let list else { return }
            let screen = window.layer.presentation() ?? window.layer
            let point = touch.location(in: window)
            touchRow = nil
            touchRowStartY = nil
            for row in rowViews(list) where row.identity.hasPrefix("chat:message:") {
                let frame = presentedFrame(row.view, in: screen)
                if frame.contains(point) {
                    touchRow = row.identity
                    touchRowStartY = frame.minY
                    break
                }
            }
        default:
            break
        }
    }

    @objc private func frame(_ link: CADisplayLink) {
        let callback = CACurrentMediaTime()
        guard let window, let list else { return }
        let screen = window.layer.presentation() ?? window.layer
        let bounds = window.bounds
        var flags = 0
        if fingerDown { flags |= Flags.finger }
        if list.isTracking { flags |= Flags.tracking }
        if list.isDragging { flags |= Flags.dragging }
        if list.isDecelerating { flags |= Flags.decelerating }
        let offset: Double
        let presented: Double
        if let ultra = list.ultra {
            if ultra.list.isScrollFlightActive { flags |= Flags.flight }
            offset = ultra.list.currentScrollOffset
            presented = Double((ultra.list.contentView.layer.presentation() ?? ultra.list.contentView.layer).bounds.origin.y)
        } else {
            offset = Double(list.collectionView.contentOffset.y)
            presented = Double((list.collectionView.layer.presentation() ?? list.collectionView.layer).bounds.origin.y)
        }
        if appliedSinceFrame { flags |= Flags.apply }
        let dockY = dock.map { Double(presentedFrame($0, in: screen).minY) } ?? -1
        if let previousDockY, abs(previousDockY - dockY) > 0.01 { flags |= Flags.dock }
        if let previousPresented, abs(previousPresented - presented) > 0.01 { flags |= Flags.motion }

        let listFrame = presentedFrame(list, in: screen).intersection(bounds)
        let newest = list.plans.first.map { "chat:message:\($0.id)" }
        var loaded = 0, onScreen = 0, ready = 0, blank = 0
        var covered: CGFloat = 0
        var positions: [String: CGFloat] = [:]
        var deltas: [CGFloat] = []
        var newestGap = -1.0
        var touchRowY = -1.0
        for row in rowViews(list) {
            loaded += 1
            let frame = presentedFrame(row.view, in: screen)
            positions[row.identity] = frame.minY
            if let before = previousRows[row.identity] { deltas.append(frame.minY - before) }
            if row.identity == newest, dockY >= 0 { newestGap = dockY - Double(frame.maxY) }
            if row.identity == touchRow { touchRowY = Double(frame.minY) }
            let visible = frame.intersection(listFrame)
            guard !visible.isNull, visible.height > 0.5 else { continue }
            onScreen += 1
            covered += visible.height
            if row.ready { ready += 1 } else { blank += 1 }
        }
        var rigid = 0.0, deviation = 0.0
        if !deltas.isEmpty {
            let sorted = deltas.sorted()
            let median = sorted[sorted.count / 2]
            rigid = Double(median)
            deviation = Double(deltas.map { abs($0 - median) }.max() ?? 0)
        }
        frames.append(Frame(
            time: link.timestamp, target: link.targetTimestamp, callback: callback, flags: flags,
            offset: offset, presented: presented, dockY: dockY, loaded: loaded, onScreen: onScreen, ready: ready, blank: blank,
            uncovered: Double(max(0, listFrame.height - covered)), rigid: rigid, deviation: deviation,
            newestGap: newestGap, touchRowY: touchRowY, turn: turnSinceFrame
        ))
        previousRows = positions
        previousDockY = dockY
        previousPresented = presented
        appliedSinceFrame = false
        turnSinceFrame = 0
        if window.subviews.last !== controls {
            window.bringSubviewToFront(summary)
            window.bringSubviewToFront(controls)
        }

        let active = flags & ~Flags.finger != 0 || fingerDown
        let index = frames.count - 1
        if active {
            if windowStart == nil {
                // One frame of lead-in, so the first gap of the window is
                // measured from the frame before it.
                windowStart = max(0, index - 1)
                touchesInWindow = fingerDown ? max(1, touchesInWindow) : 0
                appliesInWindow = 0
            }
            lastActive = index
        }
        if flags & Flags.apply != 0 { appliesInWindow += 1 }
        if let start = windowStart, !active, index - lastActive >= 30 {
            close(from: start, to: lastActive + min(30, index - lastActive))
            windowStart = nil
        }
    }

    // MARK: Windows

    private static func percentile(_ percent: Double, _ values: [Double]) -> Double {
        guard !values.isEmpty else { return 0 }
        let sorted = values.sorted()
        let rank = Int((Double(sorted.count) * percent / 100).rounded(.up)) - 1
        return sorted[min(max(rank, 0), sorted.count - 1)]
    }

    private func close(from start: Int, to end: Int) {
        let slice = Array(frames[start...min(end, frames.count - 1)])
        guard slice.count > 2 else { return }
        let periods = slice.map { $0.target - $0.time }.filter { $0 > 0 }
        let expected = Self.percentile(50, periods)
        var gaps: [Double] = []
        var missed = 0, hitches = 0
        for (previous, next) in zip(slice, slice.dropFirst()) {
            let gap = next.time - previous.time
            gaps.append(gap * 1000)
            if expected > 0 {
                missed += max(0, Int((gap / expected).rounded()) - 1)
                if gap > expected * 1.5 { hitches += 1 }
            }
        }
        let late = slice.map { ($0.callback - $0.time) * 1000 }
        var kinds = Set<String>()
        var restDrift = 0.0, nonRigid = 0.0, touchDrift = 0.0
        var gaps0: [Double] = []
        for frame in slice {
            if frame.flags & Flags.finger != 0 { kinds.insert("touch") }
            if frame.flags & (Flags.dragging | Flags.tracking) != 0 { kinds.insert("drag") }
            if frame.flags & (Flags.decelerating | Flags.flight) != 0 { kinds.insert("momentum") }
            if frame.flags & Flags.apply != 0 { kinds.insert("apply") }
            if frame.flags & Flags.dock != 0 { kinds.insert("dock") }
            nonRigid = max(nonRigid, frame.deviation)
            // Nothing should move the rows while no finger, momentum,
            // dock or apply does.
            let still = frame.flags & (Flags.finger | Flags.tracking | Flags.dragging | Flags.decelerating | Flags.flight | Flags.dock | Flags.apply) == 0
            if still { restDrift = max(restDrift, abs(frame.rigid)) }
            if frame.newestGap >= 0 { gaps0.append(frame.newestGap) }
            if let startY = touchRowStartY, frame.touchRowY >= 0 { touchDrift = max(touchDrift, abs(frame.touchRowY - startY)) }
        }
        let first = slice[0], last = slice[slice.count - 1]
        let window = Window(
            index: windows.count, start: first.time, seconds: last.time - first.time, frames: slice.count,
            expectedMs: expected * 1000,
            gapP50Ms: Self.percentile(50, gaps), gapP95Ms: Self.percentile(95, gaps), gapP99Ms: Self.percentile(99, gaps), gapMaxMs: gaps.max() ?? 0,
            missedFrames: missed, hitches: hitches,
            callbackLateP99Ms: Self.percentile(99, late), callbackLateMaxMs: late.max() ?? 0,
            turnMaxMs: slice.map(\.turn).max() ?? 0, turnsOverFrame: slice.filter { expected > 0 && $0.turn > expected * 1000 }.count,
            applies: appliesInWindow, touches: touchesInWindow,
            blankFrames: slice.filter { $0.blank > 0 }.count, blankMax: slice.map(\.blank).max() ?? 0,
            notReadyOnScreenFrames: slice.filter { $0.onScreen > $0.ready }.count,
            uncoveredMax: slice.map(\.uncovered).max() ?? 0,
            nonRigidMax: nonRigid, restDriftMax: restDrift,
            newestGapRange: (gaps0.max() ?? 0) - (gaps0.min() ?? 0),
            touchRowDriftMax: touchDrift,
            dockTravel: last.dockY - first.dockY, offsetTravel: last.presented - first.presented,
            kinds: kinds.sorted()
        )
        windows.append(window)
        touchesInWindow = 0
        appliesInWindow = 0
        flush()
    }

    /// Appends the frames not yet written and rewrites the windows, off main.
    @objc private func flush() {
        guard let directory, written < frames.count else { return }
        let pending = frames[written...]
        written = frames.count
        var text = ""
        text.reserveCapacity(pending.count * 120)
        for frame in pending {
            let fields: [String] = [
                String(format: "%.6f", frame.time), String(format: "%.6f", frame.target), String(format: "%.6f", frame.callback),
                "\(frame.flags)", String(format: "%.2f", frame.offset), String(format: "%.2f", frame.presented),
                String(format: "%.2f", frame.dockY), "\(frame.loaded)", "\(frame.onScreen)", "\(frame.ready)", "\(frame.blank)",
                String(format: "%.1f", frame.uncovered), String(format: "%.2f", frame.rigid), String(format: "%.2f", frame.deviation),
                String(format: "%.2f", frame.newestGap), String(format: "%.2f", frame.touchRowY), String(format: "%.2f", frame.turn),
            ]
            text += fields.joined(separator: ",") + "\n"
        }
        let windows = (try? JSONEncoder().encode(self.windows)) ?? Data()
        let frameURL = directory.appendingPathComponent("\(run)-frames.csv")
        let windowURL = directory.appendingPathComponent("\(run)-windows.json")
        writer.async {
            if let handle = try? FileHandle(forWritingTo: frameURL) {
                _ = try? handle.seekToEnd()
                try? handle.write(contentsOf: Data(text.utf8))
                try? handle.close()
            }
            try? windows.write(to: windowURL)
        }
    }

    // MARK: Reports

    private func json(_ value: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }

    private func rect(_ rect: CGRect) -> [Double] {
        [rect.minX, rect.minY, rect.width, rect.height].map { (Double($0) * 10).rounded() / 10 }
    }

    private func summaryReport() -> String {
        guard let list else { return "{}" }
        var collections: [UICollectionView] = []
        Self.all(UICollectionView.self, in: list, into: &collections)
        var value: [String: Any] = [:]
        value["run"] = run
        value["renderer"] = list.renderer.rawValue
        value["ultraMounted"] = list.ultra.map { $0.list.window != nil && $0.list.isDescendant(of: list) && $0.list.accessibilityIdentifier == "chat.ultralist" } ?? false
        value["collectionViews"] = collections.count
        value["rows"] = list.plans.count
        value["displayReady"] = list.isDisplayReady
        value["frames"] = frames.count
        value["windowOpen"] = windowStart != nil
        value["visibleMinY"] = Double(list.visibleMinY)
        value["maxVisibleMinY"] = Double(list.maximumVisibleMinY)
        value["moving"] = list.isTracking || list.isDragging || list.isDecelerating || (list.ultra?.list.isScrollFlightActive ?? false)
        if let data = try? JSONEncoder().encode(windows), let object = try? JSONSerialization.jsonObject(with: data) {
            value["windows"] = object
        }
        value["files"] = directory.map { ["\($0.lastPathComponent)/\(run)-frames.csv", "\($0.lastPathComponent)/\(run)-windows.json"] } ?? []
        return json(value)
    }

    /// The rows on screen, their tap and long-press targets and the native
    /// controls inside them, in window points, for tests to aim at.
    private func controlsReport() -> String {
        guard let window, let list else { return "{}" }
        let bounds = list.convert(list.bounds, to: window).intersection(window.bounds)
        var rows: [[String: Any]] = []
        var hits: [[String: Any]] = []
        var natives: [[String: Any]] = []
        for row in rowViews(list) {
            let frame = row.view.convert(row.view.bounds, to: window)
            guard frame.intersects(bounds) else { continue }
            rows.append(["id": row.identity, "f": rect(frame), "ready": row.ready])
            var canvases: [ChatPlanView] = []
            if let canvas = row.view as? ChatPlanView { canvases = [canvas] } else { Self.all(ChatPlanView.self, in: row.view, into: &canvases) }
            for canvas in canvases {
                guard let plan = canvas.plan, !(canvas.superview is ChatScrollerView) else { continue }
                for hit in plan.hits {
                    let target = canvas.convert(hit.frame, to: window)
                    guard target.intersects(bounds) else { continue }
                    var action = String(describing: hit.action).replacingOccurrences(of: "HappyUI.", with: "")
                    if action.count > 160 { action = String(action.prefix(160)) }
                    hits.append(["row": row.identity, "a": action, "hold": hit.hold, "f": rect(target)])
                }
            }
            var views: [UIView] = []
            Self.all(UIView.self, in: row.view, into: &views)
            for view in views {
                let name = NSStringFromClass(type(of: view))
                var entry: [String: Any] = ["row": row.identity]
                switch view {
                case let scroller as ChatScrollerView:
                    entry["k"] = "scroller"
                    entry["vertical"] = scroller.vertical
                    entry["content"] = [Double(scroller.contentSize.width), Double(scroller.contentSize.height)]
                    entry["offset"] = [Double(scroller.contentOffset.x), Double(scroller.contentOffset.y)]
                case is DiffShowMoreBar: entry["k"] = "showMore"
                case is ChatMermaidView: entry["k"] = "mermaid"
                case is ChatAttachmentView: entry["k"] = "attachment"
                case is ChatWebImageView: entry["k"] = "webImage"
                default:
                    guard name == "WKWebView" else { continue }
                    entry["k"] = "webView"
                    entry["object"] = "\(ObjectIdentifier(view).hashValue)"
                }
                let target = view.convert(view.bounds, to: window)
                guard target.intersects(bounds) else { continue }
                entry["f"] = rect(target)
                natives.append(entry)
            }
        }
        var value: [String: Any] = [:]
        value["renderer"] = list.renderer.rawValue
        value["list"] = rect(bounds)
        if let dock { value["dock"] = rect(dock.convert(dock.bounds, to: window)) }
        value["rows"] = rows
        value["hits"] = hits
        value["native"] = natives
        return json(value)
    }
}
#endif
