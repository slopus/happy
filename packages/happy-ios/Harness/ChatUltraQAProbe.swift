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
/// and not yet drawn, the common (rigid) movement of rows seen in both
/// frames and the largest row moving differently from it, the gap between
/// the newest message and the dock, and how far the row under the last
/// lifted finger has moved since.
///
/// Frames group into action windows: a window opens on a touch, list
/// motion, a chat list apply or a moving dock, and closes after half a
/// second with none (or after 20 seconds, to split a long stream). A
/// window reports its frame gaps against the display period (p50/p95/p99/
/// max, missed frames, hitches), main-thread turns, not-ready rows and
/// drift. Frames go to `Documents/qa/<run>-frames.csv` and windows to
/// `<run>-windows.json`. Resigning active closes the open window and
/// writes everything.
///
/// The main thread only samples and appends: analysis, formatting and
/// writing run on a serial utility queue. Reports for the UI tests are
/// cached strings, rebuilt only while no window is open, so reading them
/// costs nothing during an action. A report's `windowCount` grows only
/// after that window's frames are on disk.
///
/// `-qaRun <name>` names the files; `-qaDark` shows the window dark.
///
/// Given no chat (the Home harness), it finds the chat list in the window
/// once one is pushed, and reports each opening: from the lifted finger
/// that opened it to the first frame with the list mounted, and to the
/// first frame with rows on screen and all of them drawn (`opens`).
///
/// What the numbers are and aren't:
/// - Display-link callbacks run on the main thread: a gap is a frame the
///   main thread missed, not proof the render server missed one (UltraList
///   momentum runs in the render server). The Animation Hitches trace is the
///   authority for composited frames. `callbackDelay` is how late the
///   callback ran after its frame began (scheduling), `pastTargetFrames`
///   how many ran after the frame's deadline.
/// - "Not ready" is a mounted row whose bitmap isn't drawn yet, not proof
///   of blank pixels; `uncovered` includes the list's insets and the empty
///   space of a short chat. Videos and screenshots decide blank pixels.
/// - Drift is the rows' common movement while nothing should move them
///   (rest), on an apply away from the newest message, and of the last
///   tapped row; legitimate animations inside a window (a row opening, the
///   keyboard carrying the newest message) show up too, so each action is
///   read against what it should do.
@MainActor
final class ChatUltraQAProbe: NSObject {
    private weak var window: HarnessWindow?
    private weak var chat: UIViewController?
    private weak var cachedList: ChatListView?
    private weak var cachedDock: ChatDockView?
    private let summary = ProbeElement(frame: CGRect(x: 6, y: 0, width: 2, height: 2))
    private let controls = ProbeElement(frame: CGRect(x: 8, y: 0, width: 2, height: 2))
    private var link: CADisplayLink?
    private let run: String
    private let ledger: QALedger
    private let writer = DispatchQueue(label: "happy.chat-ultra-qa.writer", qos: .utility)

    private var batch: [QAFrame] = []
    private var frameCount = 0
    private var windowStart: Int?
    private var windowStartTime = 0.0
    private var lastActive = -1
    private var touchesInWindow = 0
    private var appliesInWindow = 0
    private var fingerDown = false
    private var fingerY = -1.0
    private var appliedSinceFrame = false
    private var turnSinceFrame = 0.0
    private var previousRows: [String: CGFloat] = [:]
    private var previousDockY: Double?
    private var previousPresented: Double?
    private var touchRow: String?
    private var touchRowStartY: CGFloat = 0
    private var lastRefresh = Int.min / 2
    private var summaryText = "{}"
    private var controlsText = "{}"
    private var windowsText = "[]"
    private var windowCount = 0
    private var linkCache: [ObjectIdentifier: (plan: ChatRowPlan, links: [(url: String, point: CGPoint)])] = [:]

    private struct Opening: Encodable {
        var renderer: String
        var mountMs: Double
        var readyMs: Double
        var rows: Int
    }
    private var lastRelease = -1.0
    private var opening: (list: ObjectIdentifier, release: Double, mount: Double, renderer: String)?
    private var openings: [Opening] = []
    private var seenLists: Set<ObjectIdentifier> = []
    private var searchSkip = 0

    init(window: HarnessWindow, chat: UIViewController?) {
        self.window = window
        self.chat = chat
        let arguments = ProcessInfo.processInfo.arguments
        let named = arguments.firstIndex(of: "-qaRun").flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil }
        run = named ?? "run-\(Int(Date().timeIntervalSince1970))"
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?.appendingPathComponent("qa")
        if let documents { try? FileManager.default.createDirectory(at: documents, withIntermediateDirectories: true) }
        ledger = QALedger(directory: documents, run: run)
        super.init()
        if arguments.contains("-qaDark") { window.overrideUserInterfaceStyle = .dark }
        for (element, name) in [(summary, "chat-ultra-qa"), (controls, "chat-ultra-qa-controls")] {
            element.isAccessibilityElement = true
            element.accessibilityIdentifier = name
            element.isUserInteractionEnabled = false
            element.alpha = 0.02
            window.addSubview(element)
        }
        summary.read = { [weak self] in self?.summaryText ?? "{}" }
        controls.read = { [weak self] in self?.controlsText ?? "{}" }
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
        let link = CADisplayLink(target: self, selector: #selector(frame(_:)))
        link.add(to: .main, forMode: .common)
        self.link = link
        NotificationCenter.default.addObserver(self, selector: #selector(resigned), name: UIApplication.willResignActiveNotification, object: nil)
    }

    // MARK: The list

    /// The chat list: in the given chat, or anywhere in the window. A
    /// window search runs every frame for three seconds after a finger
    /// lifts, and every thirtieth frame otherwise.
    private var list: ChatListView? {
        if let cachedList, cachedList.window != nil { return cachedList }
        if let chat {
            cachedList = Self.find(ChatListView.self, in: chat.view)
        } else if let window {
            let recent = lastRelease > 0 && CACurrentMediaTime() - lastRelease < 3
            searchSkip = recent ? 0 : (searchSkip + 1) % 30
            guard searchSkip == 0 else { return nil }
            cachedList = Self.find(ChatListView.self, in: window)
        }
        cachedDock = nil
        return cachedList
    }

    private var dock: ChatDockView? {
        if let cachedDock, cachedDock.window != nil { return cachedDock }
        guard let root = chat?.view ?? cachedList?.superview else { return nil }
        cachedDock = Self.find(ChatDockView.self, in: root)
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
            fingerY = Double(touch.location(in: window).y)
            touchesInWindow += 1
            touchRow = nil
        case .moved, .stationary:
            fingerY = Double(touch.location(in: window).y)
        case .ended, .cancelled:
            fingerDown = false
            lastRelease = touch.timestamp
            // The row under the finger as it lifts: a tap that opens or
            // closes it should leave it where it is.
            guard let window, let list else { return }
            let screen = window.layer.presentation() ?? window.layer
            let point = touch.location(in: window)
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
        let identity = ObjectIdentifier(list)
        if !seenLists.contains(identity) {
            seenLists.insert(identity)
            if chat == nil, lastRelease > 0 {
                opening = (identity, lastRelease, (link.targetTimestamp - lastRelease) * 1000, list.renderer.rawValue)
            }
        }
        let screen = window.layer.presentation() ?? window.layer
        var flags = 0
        if fingerDown { flags |= QAFlags.finger }
        if list.isTracking { flags |= QAFlags.tracking }
        if list.isDragging { flags |= QAFlags.dragging }
        if list.isDecelerating { flags |= QAFlags.decelerating }
        let offset: Double
        let presented: Double
        if let ultra = list.ultra {
            if ultra.list.isScrollFlightActive { flags |= QAFlags.flight }
            offset = ultra.list.currentScrollOffset
            presented = Double((ultra.list.contentView.layer.presentation() ?? ultra.list.contentView.layer).bounds.origin.y)
        } else {
            offset = Double(list.collectionView.contentOffset.y)
            presented = Double((list.collectionView.layer.presentation() ?? list.collectionView.layer).bounds.origin.y)
        }
        if appliedSinceFrame { flags |= QAFlags.apply }
        let dockY = dock.map { Double(presentedFrame($0, in: screen).minY) } ?? -1
        if let previousDockY, abs(previousDockY - dockY) > 0.01 { flags |= QAFlags.dock }
        if let previousPresented, abs(previousPresented - presented) > 0.01 { flags |= QAFlags.motion }

        let listFrame = presentedFrame(list, in: screen).intersection(window.bounds)
        let newest = list.plans.first.map { "chat:message:\($0.id)" }
        var loaded = 0, onScreen = 0, ready = 0, notReady = 0
        var covered: CGFloat = 0
        var positions: [String: CGFloat] = [:]
        var deltas: [CGFloat] = []
        var newestGap = Double.nan
        var touchDelta = Double.nan
        for row in rowViews(list) {
            loaded += 1
            let frame = presentedFrame(row.view, in: screen)
            positions[row.identity] = frame.minY
            if let before = previousRows[row.identity] { deltas.append(frame.minY - before) }
            if row.identity == newest, dockY >= 0 { newestGap = dockY - Double(frame.maxY) }
            if row.identity == touchRow { touchDelta = Double(frame.minY - touchRowStartY) }
            let visible = frame.intersection(listFrame)
            guard !visible.isNull, visible.height > 0.5 else { continue }
            onScreen += 1
            covered += visible.height
            if row.ready { ready += 1 } else { notReady += 1 }
        }
        if let open = opening, open.list == identity, onScreen > 0, notReady == 0, list.isDisplayReady {
            openings.append(Opening(renderer: open.renderer, mountMs: open.mount, readyMs: (link.targetTimestamp - open.release) * 1000, rows: onScreen))
            opening = nil
        }
        var rigid = 0.0, deviation = 0.0
        if !deltas.isEmpty {
            deltas.sort()
            let median = deltas[deltas.count / 2]
            rigid = Double(median)
            deviation = Double(max(abs(deltas[0] - median), abs(deltas[deltas.count - 1] - median)))
        }
        batch.append(QAFrame(
            time: link.timestamp, target: link.targetTimestamp, callback: callback, flags: flags,
            finger: fingerDown ? fingerY : -1, offset: offset, presented: presented, distance: Double(list.visibleMinY), dockY: dockY,
            loaded: loaded, onScreen: onScreen, ready: ready, notReady: notReady,
            uncovered: Double(max(0, listFrame.height - covered)), rigid: rigid, deviation: deviation,
            newestGap: newestGap, touchDelta: touchDelta, turn: turnSinceFrame
        ))
        let index = frameCount
        frameCount += 1
        previousRows = positions
        previousDockY = dockY
        previousPresented = presented
        appliedSinceFrame = false
        turnSinceFrame = 0

        let active = flags & ~QAFlags.finger != 0 || fingerDown
        if active {
            if windowStart == nil {
                // One frame of lead-in, so the window's first gap is
                // measured from the frame before it.
                windowStart = max(0, index - 1)
                windowStartTime = link.timestamp
                touchesInWindow = fingerDown ? max(1, touchesInWindow) : 0
                appliesInWindow = 0
            }
            lastActive = index
        }
        if flags & QAFlags.apply != 0 { appliesInWindow += 1 }
        if let start = windowStart, (!active && index - lastActive >= 30) || link.timestamp - windowStartTime > 20 {
            close(from: start, to: index)
            windowStart = active ? index : nil
            windowStartTime = link.timestamp
        } else if batch.count >= 60 {
            handOff()
        }
        if windowStart == nil, index - lastRefresh >= 30 {
            lastRefresh = index
            refreshReports()
        }
    }

    /// Gives the frames sampled so far to the writer queue.
    private func handOff() {
        guard !batch.isEmpty else { return }
        let frames = batch
        batch.removeAll(keepingCapacity: true)
        let ledger = self.ledger
        writer.async { ledger.append(frames) }
    }

    @objc private func resigned() {
        if let start = windowStart {
            close(from: start, to: frameCount - 1)
            windowStart = nil
        } else {
            handOff()
            let ledger = self.ledger
            writer.async { ledger.flush() }
        }
    }

    private func close(from start: Int, to end: Int) {
        handOff()
        let ledger = self.ledger
        let touches = touchesInWindow, applies = appliesInWindow
        touchesInWindow = 0
        appliesInWindow = 0
        writer.async { [weak self] in
            let (count, text) = ledger.close(from: start, to: end, touches: touches, applies: applies)
            ledger.flush()
            Task { @MainActor in self?.windowsArrived(count: count, text: text) }
        }
    }

    private func windowsArrived(count: Int, text: String) {
        windowCount = count
        windowsText = text
        if windowStart == nil { refreshReports() }
    }

    // MARK: Reports

    private func json(_ value: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }

    private func rect(_ rect: CGRect) -> [Double] {
        [rect.minX, rect.minY, rect.width, rect.height].map { (Double($0) * 10).rounded() / 10 }
    }

    /// Rebuilds both reports. Only while no window is open.
    private func refreshReports() {
        guard let list, let window else { return }
        window.bringSubviewToFront(summary)
        window.bringSubviewToFront(controls)
        var collections: [UICollectionView] = []
        Self.all(UICollectionView.self, in: list, into: &collections)
        var value: [String: Any] = [:]
        value["run"] = run
        value["renderer"] = list.renderer.rawValue
        value["ultraMounted"] = list.ultra.map { $0.list.window != nil && $0.list.isDescendant(of: list) && $0.list.accessibilityIdentifier == "chat.ultralist" } ?? false
        value["collectionViews"] = collections.count
        value["rows"] = list.plans.count
        value["displayReady"] = list.isDisplayReady
        value["frames"] = frameCount
        value["windowCount"] = windowCount
        value["visibleMinY"] = Double(list.visibleMinY)
        value["maxVisibleMinY"] = Double(list.maximumVisibleMinY)
        value["moving"] = list.isTracking || list.isDragging || list.isDecelerating || (list.ultra?.list.isScrollFlightActive ?? false)
        value["files"] = ["qa/\(run)-frames.csv", "qa/\(run)-windows.json"]
        if let data = try? JSONEncoder().encode(openings), let object = try? JSONSerialization.jsonObject(with: data) {
            value["opens"] = object
        }
        // The probe's clock (frame times) against the wall clock (the test's
        // marks and its screen recording).
        value["clock"] = [CACurrentMediaTime(), Date().timeIntervalSince1970]
        value["maxFPS"] = window.windowScene?.screen.maximumFramesPerSecond ?? 0
        value["scale"] = Double(window.traitCollection.displayScale)
        value["dark"] = window.traitCollection.userInterfaceStyle == .dark
        value["textSize"] = window.traitCollection.preferredContentSizeCategory.rawValue
        value["reduceMotion"] = UIAccessibility.isReduceMotionEnabled
        value["lowPower"] = ProcessInfo.processInfo.isLowPowerModeEnabled
        value["thermal"] = ProcessInfo.processInfo.thermalState.rawValue
        #if DEBUG
        value["build"] = "Debug"
        #else
        value["build"] = "Optimized, HAPPY_FIXTURES"
        #endif
        summaryText = "{\"state\":\(json(value)),\"windows\":\(windowsText)}"
        controlsText = controlsReport(list, in: window)
    }

    /// The rows on screen, their tap and long-press targets, links and the
    /// native controls inside them, in window points, for tests to aim at.
    private func controlsReport(_ list: ChatListView, in window: UIWindow) -> String {
        let bounds = list.convert(list.bounds, to: window).intersection(window.bounds)
        var rows: [[String: Any]] = []
        var hits: [[String: Any]] = []
        var natives: [[String: Any]] = []
        var links: [[String: Any]] = []
        for row in rowViews(list) {
            let frame = row.view.convert(row.view.bounds, to: window)
            guard frame.intersects(bounds) else { continue }
            var entry: [String: Any] = ["id": row.identity, "f": rect(frame), "ready": row.ready]
            if let ultraRow = (row.view as? ChatUltraRowView)?.row {
                entry["native"] = ultraRow.usesNativeDrawing
                entry["h"] = Double(ultraRow.plan.size.height)
            }
            rows.append(entry)
            var canvases: [ChatPlanView] = []
            Self.all(ChatPlanView.self, in: row.view, into: &canvases)
            for canvas in canvases {
                guard let plan = canvas.plan else { continue }
                // A strip's own hits show only inside the strip.
                var clip = bounds
                if let strip = canvas.superview as? ChatScrollerView { clip = clip.intersection(strip.convert(strip.bounds, to: window)) }
                for hit in plan.hits {
                    let target = canvas.convert(hit.frame, to: window).intersection(clip)
                    guard !target.isNull, target.width > 1, target.height > 1 else { continue }
                    var action = String(describing: hit.action).replacingOccurrences(of: "HappyUI.", with: "")
                    if action.count > 160 { action = String(action.prefix(160)) }
                    hits.append(["row": row.identity, "a": action, "hold": hit.hold, "f": rect(target)])
                }
                for (url, point) in self.links(in: plan) {
                    let shown = canvas.convert(point, to: window)
                    guard clip.contains(shown) else { continue }
                    links.append(["row": row.identity, "url": url, "p": [Double(shown.x), Double(shown.y)]])
                }
            }
            var views: [UIView] = []
            Self.all(UIView.self, in: row.view, into: &views)
            for view in views {
                var native: [String: Any] = ["row": row.identity]
                switch view {
                case let scroller as ChatScrollerView:
                    native["k"] = "scroller"
                    native["vertical"] = scroller.vertical
                    native["content"] = [Double(scroller.contentSize.width), Double(scroller.contentSize.height)]
                    native["offset"] = [Double(scroller.contentOffset.x), Double(scroller.contentOffset.y)]
                case is DiffShowMoreBar: native["k"] = "showMore"
                case is ChatMermaidView: native["k"] = "mermaid"
                case is ChatAttachmentView: native["k"] = "attachment"
                case is ChatWebImageView: native["k"] = "webImage"
                default:
                    guard NSStringFromClass(type(of: view)) == "WKWebView" else { continue }
                    native["k"] = "webView"
                    native["object"] = "\(ObjectIdentifier(view).hashValue)"
                }
                let target = view.convert(view.bounds, to: window)
                guard target.intersects(bounds) else { continue }
                native["f"] = rect(target)
                natives.append(native)
            }
        }
        var value: [String: Any] = [:]
        value["renderer"] = list.renderer.rawValue
        value["list"] = rect(bounds)
        if let dock { value["dock"] = rect(dock.convert(dock.bounds, to: window)) }
        value["rows"] = rows
        value["hits"] = hits
        value["native"] = natives
        value["links"] = links
        return json(value)
    }

    /// A point on each link in a plan's text, in the plan's coordinates,
    /// found once per plan by probing a coarse grid through the texts that
    /// carry one.
    private func links(in plan: ChatRowPlan) -> [(url: String, point: CGPoint)] {
        let key = ObjectIdentifier(plan)
        if let cached = linkCache[key], cached.plan === plan { return cached.links }
        var found: [(url: String, point: CGPoint)] = []
        for case .text(let layout, let frame) in plan.items {
            let string = layout.string
            var urls = Set<String>()
            string.enumerateAttribute(.chatLink, in: NSRange(location: 0, length: string.length)) { value, _, _ in
                if let url = value as? String { urls.insert(url) }
            }
            var probes = 0
            var y: CGFloat = 3
            while y < frame.height, !urls.isEmpty, probes < 20_000 {
                var x: CGFloat = 3
                while x < frame.width, !urls.isEmpty {
                    probes += 1
                    if let url = layout.link(at: CGPoint(x: x, y: y)), urls.contains(url) {
                        urls.remove(url)
                        found.append((String(url.prefix(120)), CGPoint(x: frame.minX + x + 4, y: frame.minY + y)))
                    }
                    x += 6
                }
                y += 5
            }
        }
        if linkCache.count > 300 { linkCache.removeAll() }
        linkCache[key] = (plan, found)
        return found
    }
}

private enum QAFlags {
    static let finger = 1, tracking = 2, dragging = 4, decelerating = 8, flight = 16, apply = 32, dock = 64, motion = 128
}

private struct QAFrame: Sendable {
    var time: Double
    var target: Double
    var callback: Double
    var flags: Int
    var finger: Double
    var offset: Double
    var presented: Double
    var distance: Double
    var dockY: Double
    var loaded: Int
    var onScreen: Int
    var ready: Int
    var notReady: Int
    var uncovered: Double
    var rigid: Double
    var deviation: Double
    var newestGap: Double
    var touchDelta: Double
    var turn: Double
}

private struct QAWindow: Encodable, Sendable {
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
    var callbackDelayP99Ms: Double
    var callbackDelayMaxMs: Double
    var pastTargetFrames: Int
    var turnMaxMs: Double
    var turnsOverFrame: Int
    var applies: Int
    var touches: Int
    var notReadyFrames: Int
    var notReadyMax: Int
    var uncoveredMax: Double
    var nonRigidMax: Double
    var restDriftMax: Double
    var awayApplyDriftMax: Double
    var newestGapMin: Double
    var newestGapMax: Double
    var touchRowDriftMax: Double
    var dockTravel: Double
    var offsetTravel: Double
    var kinds: [String]
}

/// Every frame and window, used only on the probe's writer queue.
private final class QALedger: @unchecked Sendable {
    private var frames: [QAFrame] = []
    private var written = 0
    private var windows: [QAWindow] = []
    private let frameURL: URL?
    private let windowURL: URL?

    init(directory: URL?, run: String) {
        frameURL = directory?.appendingPathComponent("\(run)-frames.csv")
        windowURL = directory?.appendingPathComponent("\(run)-windows.json")
        let header = "time,target,callback,flags,finger,offset,presented,distance,dockY,loaded,onScreen,ready,notReady,uncovered,rigid,deviation,newestGap,touchDelta,turn\n"
        if let frameURL { try? header.write(to: frameURL, atomically: true, encoding: .utf8) }
    }

    func append(_ batch: [QAFrame]) {
        frames.append(contentsOf: batch)
    }

    private static func percentile(_ percent: Double, _ values: [Double]) -> Double {
        guard !values.isEmpty else { return 0 }
        let sorted = values.sorted()
        let rank = Int((Double(sorted.count) * percent / 100).rounded(.up)) - 1
        return sorted[min(max(rank, 0), sorted.count - 1)]
    }

    /// Analyses frames `start...end` as one window; returns how many windows
    /// there are and all of them as JSON.
    func close(from start: Int, to end: Int, touches: Int, applies: Int) -> (Int, String) {
        let lower = max(0, start), upper = min(end, frames.count - 1)
        guard upper - lower >= 2 else { return (windows.count, encoded()) }
        let slice = frames[lower...upper]
        let expected = Self.percentile(50, slice.map { $0.target - $0.time }.filter { $0 > 0 })
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
        let delays = slice.map { ($0.callback - $0.time) * 1000 }
        let moving = QAFlags.finger | QAFlags.tracking | QAFlags.dragging | QAFlags.decelerating | QAFlags.flight | QAFlags.dock
        var kinds = Set<String>()
        var restDrift = 0.0, awayDrift = 0.0, nonRigid = 0.0, touchDrift = 0.0
        var newestGaps: [Double] = []
        for frame in slice {
            if frame.flags & QAFlags.finger != 0 { kinds.insert("touch") }
            if frame.flags & (QAFlags.dragging | QAFlags.tracking) != 0 { kinds.insert("drag") }
            if frame.flags & (QAFlags.decelerating | QAFlags.flight) != 0 { kinds.insert("momentum") }
            if frame.flags & QAFlags.apply != 0 { kinds.insert("apply") }
            if frame.flags & QAFlags.dock != 0 { kinds.insert("dock") }
            nonRigid = max(nonRigid, frame.deviation)
            // Nothing should move the rows while no finger, momentum, dock
            // or apply does.
            if frame.flags & (moving | QAFlags.apply) == 0 { restDrift = max(restDrift, abs(frame.rigid)) }
            // Away from the newest message (past the follow zone) an apply
            // keeps the reader's rows where they are.
            if frame.flags & moving == 0, frame.flags & QAFlags.apply != 0, frame.distance > 220 {
                awayDrift = max(awayDrift, abs(frame.rigid))
            }
            if !frame.newestGap.isNaN { newestGaps.append(frame.newestGap) }
            if !frame.touchDelta.isNaN { touchDrift = max(touchDrift, abs(frame.touchDelta)) }
        }
        let first = slice[lower], last = slice[upper]
        windows.append(QAWindow(
            index: windows.count, start: first.time, seconds: last.time - first.time, frames: slice.count,
            expectedMs: expected * 1000,
            gapP50Ms: Self.percentile(50, gaps), gapP95Ms: Self.percentile(95, gaps), gapP99Ms: Self.percentile(99, gaps), gapMaxMs: gaps.max() ?? 0,
            missedFrames: missed, hitches: hitches,
            callbackDelayP99Ms: Self.percentile(99, delays), callbackDelayMaxMs: delays.max() ?? 0,
            pastTargetFrames: slice.filter { $0.callback > $0.target }.count,
            turnMaxMs: slice.map(\.turn).max() ?? 0, turnsOverFrame: slice.filter { expected > 0 && $0.turn > expected * 1000 }.count,
            applies: applies, touches: touches,
            notReadyFrames: slice.filter { $0.notReady > 0 }.count, notReadyMax: slice.map(\.notReady).max() ?? 0,
            uncoveredMax: slice.map(\.uncovered).max() ?? 0,
            nonRigidMax: nonRigid, restDriftMax: restDrift, awayApplyDriftMax: awayDrift,
            newestGapMin: newestGaps.min() ?? -1, newestGapMax: newestGaps.max() ?? -1,
            touchRowDriftMax: touchDrift,
            dockTravel: last.dockY - first.dockY, offsetTravel: last.presented - first.presented,
            kinds: kinds.sorted()
        ))
        return (windows.count, encoded())
    }

    private func encoded() -> String {
        let encoder = JSONEncoder()
        encoder.nonConformingFloatEncodingStrategy = .convertToString(positiveInfinity: "inf", negativeInfinity: "-inf", nan: "nan")
        guard let data = try? encoder.encode(windows) else { return "[]" }
        return String(decoding: data, as: UTF8.self)
    }

    /// Appends the frames not yet written and rewrites the windows.
    func flush() {
        if let frameURL, written < frames.count {
            var text = ""
            text.reserveCapacity((frames.count - written) * 130)
            for frame in frames[written...] {
                let fields: [String] = [
                    String(format: "%.6f", frame.time), String(format: "%.6f", frame.target), String(format: "%.6f", frame.callback),
                    "\(frame.flags)", String(format: "%.1f", frame.finger), String(format: "%.2f", frame.offset), String(format: "%.2f", frame.presented), String(format: "%.2f", frame.distance),
                    String(format: "%.2f", frame.dockY), "\(frame.loaded)", "\(frame.onScreen)", "\(frame.ready)", "\(frame.notReady)",
                    String(format: "%.1f", frame.uncovered), String(format: "%.2f", frame.rigid), String(format: "%.2f", frame.deviation),
                    String(format: "%.2f", frame.newestGap), String(format: "%.2f", frame.touchDelta), String(format: "%.2f", frame.turn),
                ]
                text += fields.joined(separator: ",") + "\n"
            }
            written = frames.count
            if let handle = try? FileHandle(forWritingTo: frameURL) {
                _ = try? handle.seekToEnd()
                try? handle.write(contentsOf: Data(text.utf8))
                try? handle.close()
            }
        }
        if let windowURL { try? Data(encoded().utf8).write(to: windowURL) }
    }
}
#endif
