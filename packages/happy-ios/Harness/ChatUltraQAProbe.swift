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
/// finger arriving in a window of applies alone starts a new one. A
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
/// once one is pushed, and reports each opening (`opens`), from the lifted
/// finger that opened it to the target time of the first frame with the
/// list mounted (`mountMs`), on screen as presented (`visibleMs`), with rows
/// on screen and all of them drawn (`readyMs`), and where it comes to rest
/// (`settledMs`); with the frames shown before the rows were drawn, the
/// frames missed, and the longest main-thread turn and synchronous chat
/// apply from the finger to rest. Frame granular: one display period, and
/// none of them is the start of the push animation. From the finger's own
/// delivery: `handlerMs`, when the window finished delivering it (its tap
/// handlers had run), and `pushStartedInDelivery`, whether a navigation
/// transition had begun by then.
///
/// `applyMs` is the longest time one chat apply (`ApplyPerf`: list,
/// session, snapshot) held the main thread synchronously within a frame,
/// `applySumMs` all of them together; the UltraList's asynchronous
/// preparation and drawing show up as not-ready rows, and everything else
/// on the main thread as `turn`. `memoryMB` is the process footprint,
/// sampled every half second.
///
/// An opening is visible once the list's layer has been committed (it has
/// a presentation layer) and shows on screen, and settled once no
/// navigation transition is running and the presented frame equals the
/// model's.
///
/// Rows count from the first frame after their layer's first commit:
/// before it the render server doesn't have them, and their model frame
/// can be mid-change (`uncommitted` counts them).
///
/// Each frame with a mounted row on screen not drawn adds a line to
/// `<run>-notready.jsonl`: the row, its visible rect against the header
/// and the dock, whether its layer has been committed, and what its NodeRow
/// view holds (shown, pending and released hosts, read by reflection), to
/// tell a fresh row from retained pixels or an occluded one.
///
/// `redacted` (the TEST account) reports counts and geometry only: no
/// controls report, no row identities.
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
    private var windowTouched = false
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

    /// One chat opened from Home. Times from the lifted finger, in ms; -1
    /// if it didn't happen within five seconds.
    private struct Opening: Encodable {
        var renderer: String
        var mountMs: Double
        var visibleMs = -1.0
        var readyMs = -1.0
        var settledMs = -1.0
        var notReadyVisibleFrames = 0
        var missedFrames = 0
        var turnMaxMs = 0.0
        var applyMaxMs = 0.0
        var rows = 0
        var handlerMs = -1.0
        var pushStartedInDelivery = false
        /// The opened chat's own timings, copied once the opening closes:
        /// building it (`constructionSeconds`), its view load, its layouts
        /// while opening, and each deferred construction step, in ms.
        var constructionMs = -1.0
        var loadingMs = -1.0
        var openingLayoutMs = -1.0
        var constructionStageMs: [Double] = []
    }
    /// One finger lifted on Home with Home on screen, and the first frame
    /// that showed it took effect: the new chat's view, committed and
    /// intersecting the window, or Home presented away from where it was at
    /// the release. Times in ms from the release (`UITouch.timestamp`, the
    /// display-link clock), per sample: its callback, its link timestamp,
    /// its target, and the previous sample's callback. The change happened
    /// after the previous sample: `lowerMs` is that sample's callback, and
    /// `targetMs` the frame it is bound for, a frame bound and no proof of
    /// photons.
    private struct FirstVisual: Encodable {
        var kind = "none"
        /// A new chat's view committed within two seconds.
        var chat = false
        /// Samples with no change seen that couldn't see the window or
        /// Home as presented.
        var unknownSamples = 0
        var callbackMs = -1.0, timestampMs = -1.0, targetMs = -1.0, lowerMs = -1.0
        var shellCommittedMs = -1.0
        var shellFraction = 0.0
        var homeDx = 0.0, homeDy = 0.0
        /// The first twelve samples: target ms, shell committed, its
        /// visible fraction, Home's presented shift from its baseline, and
        /// whether Home could be read (the shift is 0 when it couldn't).
        var samples: [[Double]] = []
    }
    private struct FirstVisualTrack {
        var release: Double
        var home: HomeViewController
        var baseline: CGRect
        var known: Set<ObjectIdentifier>
        var previousCallback: Double
        var result = FirstVisual()
    }

    /// The last lifted finger's delivery: its timestamp, when delivery
    /// ended, and whether a push had begun by then.
    private var delivered: (release: Double, handlerMs: Double, pushing: Bool)?
    private var lastRelease = -1.0
    /// The first visual response to a finger lifted on Home: pending from
    /// the release until a new chat's view or Home itself shows a change.
    private var firstVisual: FirstVisualTrack?
    private var firstVisuals: [FirstVisual] = []
    private var opening: (list: ObjectIdentifier, release: Double, progress: Opening, lastTime: Double)?
    private var openings: [Opening] = []
    private var seenLists: Set<ObjectIdentifier> = []
    private var searchSkip = 0
    private var ticksAway = 0
    private let redacted: Bool
    /// Since the last lifted finger: the longest turn and synchronous chat
    /// apply, for an opening's time before its list mounted.
    private var turnSinceRelease = 0.0
    private var applySinceRelease = 0.0
    private var applyStarted: [ApplySite: CFTimeInterval] = [:]
    private var applyMsSinceFrame = 0.0
    private var applySumSinceFrame = 0.0
    private var memoryMB = -1.0
    private var memoryPeakMB = -1.0
    private var memoryTick = 0
    private var notes: [String] = []
    private var lastNotes: [String] = []
    /// Every presented row frame and opacity, for comparing arrival motion.
    private let tracesRows = ProcessInfo.processInfo.arguments.contains("-qaRows")
    private var rowLines: [String] = []

    init(window: HarnessWindow, chat: UIViewController?, redacted: Bool = false) {
        self.window = window
        self.chat = chat
        self.redacted = redacted
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
        let previousAfter = window.afterTouch
        window.afterTouch = { [weak self] touch in
            previousAfter?(touch)
            self?.deliveredTouch(touch)
        }
        ApplyPerf.onWillApply = { [weak self] site in
            guard Self.chatSites.contains(site) else { return }
            self?.applyStarted[site] = CACurrentMediaTime()
        }
        ApplyPerf.onApply = { [weak self] site, _ in
            guard let self, let started = applyStarted.removeValue(forKey: site) else { return }
            if site == .chatList { appliedSinceFrame = true }
            let milliseconds = (CACurrentMediaTime() - started) * 1000
            applyMsSinceFrame = max(applyMsSinceFrame, milliseconds)
            applySumSinceFrame += milliseconds
            applySinceRelease = max(applySinceRelease, milliseconds)
        }
        MainThreadMonitor.shared.onTurn = { [weak self] turn in
            guard let self else { return }
            self.turnSinceFrame = max(self.turnSinceFrame, turn.milliseconds)
            self.turnSinceRelease = max(self.turnSinceRelease, turn.milliseconds)
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

    /// What a chat shows in place of its rows, if anything: the kind only,
    /// never the chat's own text. "none" while no placeholder shows.
    private func placeholderKind(in root: UIView) -> String {
        guard let view = Self.find(ChatPlaceholderView.self, in: root), !view.isHidden, view.alpha > 0.01,
              let content = view.content else { return "none" }
        switch content {
        case .loading: return "loading"
        case .loadFailed: return "loadFailed"
        case .empty(_, let status): return "empty:\(status)"
        case .pendingChat: return "pendingChat"
        case .deleted: return "deleted"
        }
    }

    /// The chat rows Home shows on screen, top to bottom, as frames in the
    /// window: where to tap, never what they say.
    private func homeChatFrames(in window: UIWindow) -> [[Double]] {
        var cells: [UITableViewCell] = []
        Self.all(UITableViewCell.self, in: window, into: &cells)
        return cells.filter { $0 is SessionRowCell || $0 is ProjectChatCell }
            .map { $0.convert($0.bounds, to: window) }
            .filter { $0.minY >= 0 && $0.maxY <= window.bounds.maxY && $0.height > 20 }
            .sorted { $0.minY < $1.minY }
            .map(rect)
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
            // An opening's longest turn and apply count from its own finger.
            turnSinceRelease = 0
            applySinceRelease = 0
            if chat == nil { startFirstVisual(release: touch.timestamp) }
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

    /// After the window delivered a lifted finger: how long since it
    /// lifted, and whether a navigation controller is mid-transition.
    private func deliveredTouch(_ touch: UITouch) {
        guard touch.phase == .ended || touch.phase == .cancelled, let window else { return }
        let handlerMs = (CACurrentMediaTime() - touch.timestamp) * 1000
        delivered = (touch.timestamp, handlerMs, Self.transitioning(window.rootViewController))
    }

    // MARK: First visual response

    /// Starts watching a release on Home: only while Home is in the window,
    /// presented, and no chat is shown over it (a tab or a chat's own touch
    /// isn't an opening from Home). Home's presented frame now is the
    /// baseline, and the chats that exist now aren't new.
    private func startFirstVisual(release: Double) {
        guard let window, let root = window.rootViewController,
              let home = Self.controllers(from: root).compactMap({ $0 as? HomeViewController }).first,
              let homeView = home.viewIfLoaded, homeView.window === window,
              let screen = window.layer.presentation(), let presented = homeView.layer.presentation(),
              presented.convert(presented.bounds, to: screen).intersects(window.bounds),
              (Self.presentedOpacity(homeView) ?? 0) > 0.01 else { return }
        let chats = Self.controllers(from: root).filter { $0 is ChatViewController }
        guard !chats.contains(where: { $0.viewIfLoaded?.window === window }) else { return }
        firstVisual = FirstVisualTrack(
            release: release, home: home, baseline: presented.convert(presented.bounds, to: screen),
            known: Set(chats.map(ObjectIdentifier.init)), previousCallback: CACurrentMediaTime()
        )
    }

    /// One display-link sample of a pending release. Every frame, opacity
    /// and hidden flag read is a presentation layer's.
    private func sampleFirstVisual(_ link: CADisplayLink, callback: Double, in window: HarnessWindow) {
        guard var track = firstVisual else { return }
        let ms = { (time: Double) in (time - track.release) * 1000 }
        // Nothing within two seconds: kept as it stands.
        guard ms(callback) <= 2000 else {
            firstVisuals.append(track.result)
            firstVisual = nil
            return
        }
        // Without the window as presented nothing can be placed on screen:
        // an unknown sample, neither a change nor past `lowerMs`.
        guard let screen = window.layer.presentation() else {
            track.result.unknownSamples += 1
            firstVisual = track
            return
        }
        // The new chat's view: committed once it and every view above it
        // have a presentation layer; shown once it also intersects the
        // window and isn't hidden or transparent there. Seen whether or not
        // Home still is.
        var shellCommitted = false
        var fraction = 0.0
        if let root = window.rootViewController,
           let shell = Self.controllers(from: root).first(where: { $0 is ChatViewController && !track.known.contains(ObjectIdentifier($0)) }),
           let view = shell.viewIfLoaded, view.window === window, let presented = view.layer.presentation(),
           let opacity = Self.presentedOpacity(view) {
            shellCommitted = true
            let frame = presented.convert(presented.bounds, to: screen)
            let shown = frame.intersection(window.bounds)
            if opacity > 0.01, !shown.isNull, shown.width >= 1, shown.height >= 1, frame.width > 0, frame.height > 0 {
                fraction = Double(shown.width * shown.height / (frame.width * frame.height))
            }
        }
        // Home as presented, if it still can be read (it leaves the window
        // once the push ends): its move counts only while it can be seen.
        var homeKnown = false
        var homeMoved = false
        var dx = 0.0, dy = 0.0
        if let homeView = track.home.viewIfLoaded, homeView.window === window,
           let homePresented = homeView.layer.presentation(), let homeOpacity = Self.presentedOpacity(homeView) {
            homeKnown = true
            let homeFrame = homePresented.convert(homePresented.bounds, to: screen)
            dx = Double(homeFrame.minX - track.baseline.minX)
            dy = Double(homeFrame.minY - track.baseline.minY)
            homeMoved = homeOpacity > 0.01 && homeFrame.intersects(window.bounds) && (abs(dx) >= 0.5 || abs(dy) >= 0.5)
        }
        if shellCommitted, track.result.shellCommittedMs < 0 {
            track.result.shellCommittedMs = ms(link.targetTimestamp)
            track.result.chat = true
        }
        if track.result.samples.count < 12 {
            track.result.samples.append([ms(link.targetTimestamp), shellCommitted ? 1 : 0, fraction, dx, homeKnown ? 1 : 0].map { ($0 * 100).rounded() / 100 })
        }
        let changed = fraction > 0 || homeMoved
        // `lowerMs` is the last sample that saw everything and no change.
        let lower = max(0, ms(track.previousCallback))
        if track.result.callbackMs < 0, changed {
            track.result.kind = fraction > 0 ? (homeMoved ? "shell+home" : "shell") : "home"
            track.result.callbackMs = ms(callback)
            track.result.timestampMs = ms(link.timestamp)
            track.result.targetMs = ms(link.targetTimestamp)
            track.result.lowerMs = lower
            track.result.shellFraction = fraction
            track.result.homeDx = dx
            track.result.homeDy = dy
        } else if !changed {
            if homeKnown {
                track.previousCallback = callback
            } else {
                track.result.unknownSamples += 1
            }
        }
        // Done once a new chat has committed, the first change is in and
        // twelve samples are: a release that only moved Home (Settings, a
        // project's sheet) runs to the two seconds with `chat` false.
        if track.result.chat, track.result.callbackMs >= 0, track.result.samples.count >= 12 {
            firstVisuals.append(track.result)
            firstVisual = nil
        } else {
            firstVisual = track
        }
    }

    /// A view's opacity as presented, times its ancestors' up to the
    /// window: 0 if any of them is hidden, nil if any has no presentation
    /// layer.
    private static func presentedOpacity(_ view: UIView) -> Float? {
        var opacity: Float = 1
        var current: UIView? = view
        while let next = current {
            guard let layer = next.layer.presentation() else { return nil }
            if layer.isHidden { return 0 }
            opacity *= layer.opacity
            if next is UIWindow { break }
            current = next.superview
        }
        return opacity
    }

    /// The controllers under `root`: children and presented ones.
    private static func controllers(from root: UIViewController) -> [UIViewController] {
        [root] + root.children.flatMap(controllers) + (root.presentedViewController.map(controllers) ?? [])
    }

    /// Whether a navigation controller at or under `controller` is in a
    /// transition.
    private static func transitioning(_ controller: UIViewController?) -> Bool {
        guard let controller else { return false }
        if let navigation = controller as? UINavigationController, navigation.transitionCoordinator != nil { return true }
        return controller.children.contains { transitioning($0) } || transitioning(controller.presentedViewController)
    }

    @objc private func frame(_ link: CADisplayLink) {
        let callback = CACurrentMediaTime()
        guard let window else { return }
        sampleMemory()
        if firstVisual != nil { sampleFirstVisual(link, callback: callback, in: window) }
        // Another screen covers the chat (Home, a pushed message): close the
        // open window and keep the reports saying so. What happened while
        // away isn't the next frame's.
        guard let list, list.window != nil else {
            if let start = windowStart {
                close(from: start, to: frameCount - 1)
                windowStart = nil
            }
            appliedSinceFrame = false
            applyMsSinceFrame = 0
            applySumSinceFrame = 0
            turnSinceFrame = 0
            previousRows = [:]
            previousDockY = nil
            previousPresented = nil
            ticksAway += 1
            if ticksAway % 30 == 1 { refreshReports() }
            return
        }
        ticksAway = 0
        let identity = ObjectIdentifier(list)
        if !seenLists.contains(identity) {
            seenLists.insert(identity)
            if chat == nil, lastRelease > 0 {
                var progress = Opening(renderer: list.renderer.rawValue, mountMs: (link.targetTimestamp - lastRelease) * 1000)
                progress.turnMaxMs = turnSinceRelease
                progress.applyMaxMs = applySinceRelease
                if let delivered, delivered.release == lastRelease {
                    progress.handlerMs = delivered.handlerMs
                    progress.pushStartedInDelivery = delivered.pushing
                }
                opening = (identity, lastRelease, progress, 0)
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
        var loaded = 0, onScreen = 0, ready = 0, notReady = 0, uncommitted = 0
        var covered: CGFloat = 0
        var positions: [String: CGFloat] = [:]
        var deltas: [CGFloat] = []
        var newestGap = Double.nan
        var touchDelta = Double.nan
        var traced: [String] = []
        for row in rowViews(list) {
            loaded += 1
            // A row the render server hasn't received yet isn't on screen:
            // its model frame can be mid-change (a rebase as momentum takes
            // over). It counts from the first frame after its commit.
            guard row.view.layer.presentation() != nil else {
                uncommitted += 1
                continue
            }
            let frame = presentedFrame(row.view, in: screen)
            positions[row.identity] = frame.minY
            if tracesRows {
                let opacity = (row.view.layer.presentation() ?? row.view.layer).opacity
                traced.append(String(format: "[\"%@\",%.2f,%.2f,%.3f]", row.identity, frame.minY, frame.maxY, opacity))
            }
            if let before = previousRows[row.identity] { deltas.append(frame.minY - before) }
            if row.identity == newest, dockY >= 0 { newestGap = dockY - Double(frame.maxY) }
            if row.identity == touchRow { touchDelta = Double(frame.minY - touchRowStartY) }
            let visible = frame.intersection(listFrame)
            guard !visible.isNull, visible.height > 0.5 else { continue }
            onScreen += 1
            covered += visible.height
            if row.ready {
                ready += 1
            } else {
                notReady += 1
                note(row.view, identity: row.identity, visible: visible, dockY: dockY, link: link, flags: flags)
            }
        }
        if tracesRows {
            rowLines.append(String(format: "{\"t\":%.6f,\"dock\":%.2f,\"offset\":%.2f,\"presented\":%.2f,\"rows\":[%@]}",
                                   link.targetTimestamp, dockY, offset, presented, traced.joined(separator: ",")))
        }
        if let open = opening, open.list == identity {
            track(open, link: link, list: list, listFrame: listFrame, screen: screen, onScreen: onScreen, notReady: notReady)
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
            loaded: loaded, uncommitted: uncommitted, onScreen: onScreen, ready: ready, notReady: notReady,
            uncovered: Double(max(0, listFrame.height - covered)), rigid: rigid, deviation: deviation,
            newestGap: newestGap, touchDelta: touchDelta, turn: turnSinceFrame, applyMs: applyMsSinceFrame, applySumMs: applySumSinceFrame, memoryMB: memoryMB
        ))
        let index = frameCount
        frameCount += 1
        previousRows = positions
        previousDockY = dockY
        previousPresented = presented
        appliedSinceFrame = false
        applyMsSinceFrame = 0
        applySumSinceFrame = 0
        turnSinceFrame = 0

        let active = flags & ~QAFlags.finger != 0 || fingerDown
        if fingerDown, let start = windowStart, !windowTouched, index - start > 2 {
            // A finger joins a window of applies alone (a stream, the
            // opening): the touch gets a window of its own.
            let touches = touchesInWindow
            touchesInWindow = 0
            close(from: start, to: index - 1)
            windowStart = index - 1
            windowStartTime = link.timestamp
            touchesInWindow = max(1, touches)
        }
        if active {
            if windowStart == nil {
                // One frame of lead-in, so the window's first gap is
                // measured from the frame before it.
                windowStart = max(0, index - 1)
                windowStartTime = link.timestamp
                touchesInWindow = fingerDown ? max(1, touchesInWindow) : 0
                appliesInWindow = 0
                windowTouched = false
            }
            lastActive = index
        }
        if fingerDown { windowTouched = true }
        if flags & QAFlags.apply != 0 { appliesInWindow += 1 }
        if let start = windowStart, (!active && index - lastActive >= 30) || link.timestamp - windowStartTime > 20 {
            close(from: start, to: index)
            windowStart = active ? index : nil
            windowStartTime = link.timestamp
            windowTouched = fingerDown
        } else if batch.count >= 60 {
            handOff()
        }
        if windowStart == nil, index - lastRefresh >= 30 {
            lastRefresh = index
            refreshReports()
        }
    }

    private static let chatSites: Set<ApplySite> = [.chatList, .chatSession, .chatSnapshot]

    /// One frame of an opening: when the list first shows as presented,
    /// has every row on screen drawn, and stops moving.
    private func track(_ open: (list: ObjectIdentifier, release: Double, progress: Opening, lastTime: Double), link: CADisplayLink,
                       list: ChatListView, listFrame: CGRect, screen: CALayer, onScreen: Int, notReady: Int) {
        guard let window else { return }
        var progress = open.progress
        let since = (link.targetTimestamp - open.release) * 1000
        let period = link.targetTimestamp - link.timestamp
        if open.lastTime > 0, period > 0 {
            progress.missedFrames += max(0, Int(((link.timestamp - open.lastTime) / period).rounded()) - 1)
        }
        progress.turnMaxMs = max(progress.turnMaxMs, turnSinceFrame)
        progress.applyMaxMs = max(progress.applyMaxMs, applyMsSinceFrame)
        // Before its first commit a layer has no presentation, and its
        // "presented" frame is the model's.
        let committed = list.layer.presentation() != nil
        let shown = committed && !listFrame.isNull && listFrame.width > 1 && listFrame.height > 1
        if shown, progress.visibleMs < 0 { progress.visibleMs = since }
        let drawn = onScreen > 0 && notReady == 0 && list.isDisplayReady
        if shown, !drawn { progress.notReadyVisibleFrames += 1 }
        if drawn, progress.readyMs < 0 {
            progress.readyMs = since
            progress.rows = onScreen
        }
        let model = list.convert(list.bounds, to: window)
        let presented = presentedFrame(list, in: screen)
        if shown, progress.settledMs < 0, !Self.transitioning(window.rootViewController),
           abs(model.minX - presented.minX) < 0.5, abs(model.minY - presented.minY) < 0.5 {
            progress.settledMs = since
        }
        if (progress.readyMs >= 0 && progress.settledMs >= 0) || since > 5000 {
            // The chat that holds this list.
            if let chat = sequence(first: list as UIResponder, next: { $0.next }).first(where: { $0 is ChatViewController }) as? ChatViewController {
                let ms = { (seconds: CFTimeInterval) in (seconds * 100_000).rounded() / 100 }
                progress.constructionMs = ms(chat.constructionSeconds)
                progress.loadingMs = ms(chat.loadingSeconds)
                progress.openingLayoutMs = ms(chat.openingLayoutSeconds)
                progress.constructionStageMs = chat.constructionStageSeconds.map(ms)
            }
            openings.append(progress)
            opening = nil
        } else {
            opening = (open.list, open.release, progress, link.timestamp)
        }
    }

    /// `mach_task_self_`, read once: Swift 6 refuses the C global itself.
    private static let task: mach_port_t = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "mach_task_self_")?.load(as: mach_port_t.self) ?? 0

    /// The process footprint, every thirtieth frame.
    private func sampleMemory() {
        memoryTick += 1
        guard memoryTick % 30 == 1 else { return }
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(Self.task, task_flavor_t(TASK_VM_INFO), $0, &count) }
        }
        guard result == KERN_SUCCESS else { return }
        memoryMB = (Double(info.phys_footprint) / 1_048_576 * 10).rounded() / 10
        memoryPeakMB = max(memoryPeakMB, memoryMB)
    }

    /// Gives the frames sampled so far to the writer queue.
    /// Why a mounted row on screen isn't drawn, for `<run>-notready.jsonl`.
    private func note(_ view: UIView, identity: String, visible: CGRect, dockY: Double, link: CADisplayLink, flags: Int) {
        var entry: [String: Any] = [
            "frame": frameCount, "time": link.timestamp, "flags": flags,
            "id": redacted ? "row" : identity, "class": NSStringFromClass(type(of: view)),
            "visible": rect(visible), "committed": view.layer.presentation() != nil,
            "hidden": view.isHidden, "alpha": Double(view.alpha),
        ]
        if let window {
            // ChatHeaderLayout.Metrics.height under the safe area.
            entry["underHeader"] = visible.maxY <= window.safeAreaInsets.top + 44
            entry["underDock"] = dockY >= 0 && visible.minY >= dockY
        }
        if let ultra = view as? ChatUltraRowView {
            entry["native"] = ultra.row.usesNativeDrawing
            entry["planHeight"] = Double(ultra.row.plan.size.height)
            if let drawing = Mirror(reflecting: ultra).children.first(where: { $0.label == "drawing" })?.value as? UIView {
                entry["drawing"] = NSStringFromClass(type(of: drawing))
                if let rowView = drawing as? ListRowView { entry["drawingReady"] = rowView.isDisplayReady }
                entry["drawingCommitted"] = drawing.layer.presentation() != nil
                for child in Mirror(reflecting: drawing).children {
                    guard let label = child.label, ["displayedHost", "pendingHost", "releasedSnapshot"].contains(label) else { continue }
                    if let held = child.value as? UIView {
                        entry[label] = ["class": NSStringFromClass(type(of: held)), "hidden": held.isHidden, "frame": rect(held.frame),
                                        "committed": held.layer.presentation() != nil]
                    } else {
                        entry[label] = "nil"
                    }
                }
                entry["subviews"] = drawing.subviews.map { "\(NSStringFromClass(type(of: $0)))\($0.isHidden ? " hidden" : "") \(rect($0.frame))" }
            } else {
                entry["drawing"] = "unknown"
            }
        }
        let line = json(entry)
        notes.append(line)
        lastNotes.append(line)
        if lastNotes.count > 6 { lastNotes.removeFirst(lastNotes.count - 6) }
    }

    private func handOff() {
        guard !batch.isEmpty else { return }
        let frames = batch
        batch.removeAll(keepingCapacity: true)
        let ledger = self.ledger
        let lines = notes
        notes.removeAll()
        let rows = rowLines
        rowLines.removeAll()
        writer.async { ledger.append(frames, notes: lines, rows: rows) }
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
        guard let window else { return }
        guard let list, list.window != nil else {
            var away: [String: Any] = ["run": run, "listInWindow": false, "windowCount": windowCount, "moving": false, "frames": frameCount]
            away["opens"] = openingsObject()
            away["firstVisuals"] = firstVisualsObject()
            away["placeholder"] = placeholderKind(in: window)
            away["homeChats"] = homeChatFrames(in: window)
            away["memoryMB"] = memoryMB
            away["memoryPeakMB"] = memoryPeakMB
            summaryText = "{\"state\":\(json(away)),\"windows\":\(windowsText)}"
            controlsText = "{}"
            return
        }
        window.bringSubviewToFront(summary)
        window.bringSubviewToFront(controls)
        var collections: [UICollectionView] = []
        Self.all(UICollectionView.self, in: list, into: &collections)
        var value: [String: Any] = [:]
        value["run"] = run
        value["listInWindow"] = true
        value["renderer"] = list.renderer.rawValue
        value["ultraMounted"] = list.ultra.map { $0.list.window != nil && $0.list.isDescendant(of: list) && $0.list.accessibilityIdentifier == "chat.ultralist" } ?? false
        value["collectionViews"] = collections.count
        value["rows"] = list.plans.count
        value["displayReady"] = list.isDisplayReady
        value["placeholder"] = placeholderKind(in: window)
        value["frames"] = frameCount
        value["windowCount"] = windowCount
        value["visibleMinY"] = Double(list.visibleMinY)
        value["maxVisibleMinY"] = Double(list.maximumVisibleMinY)
        value["moving"] = list.isTracking || list.isDragging || list.isDecelerating || (list.ultra?.list.isScrollFlightActive ?? false)
        value["files"] = ["qa/\(run)-frames.csv", "qa/\(run)-windows.json"]
        value["opens"] = openingsObject()
        value["firstVisuals"] = firstVisualsObject()
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
        value["memoryMB"] = memoryMB
        value["memoryPeakMB"] = memoryPeakMB
        value["redacted"] = redacted
        value["notReadyLast"] = lastNotes
        if let ultra = list.ultra, !list.isDisplayReady { value["ultraNotReady"] = ultraState(ultra) }
        #if DEBUG
        value["build"] = "Debug"
        #else
        value["build"] = "Optimized, HAPPY_FIXTURES"
        #endif
        summaryText = "{\"state\":\(json(value)),\"windows\":\(windowsText)}"
        controlsText = redacted ? "{}" : controlsReport(list, in: window)
    }

    /// An UltraList chat that isn't drawn: what the list holds, what it has
    /// mounted, and the adapter's own submission count (by reflection).
    private func ultraState(_ ultra: ChatUltraListAdapter) -> [String: Any] {
        let list = ultra.list
        var value: [String: Any] = [
            "bounds": rect(list.bounds), "items": list.items.count,
            "loadedRange": [list.loadedIndexRange.lowerBound, list.loadedIndexRange.upperBound],
            "loadedViews": list.loadedItemViews.count, "readyViews": list.loadedItemViews.filter(\.isDisplayReady).count,
            "lastRevision": list.items.last.map { Double($0.revision) } ?? -1,
            "tracking": list.isTracking, "flight": list.isScrollFlightActive,
        ]
        for child in Mirror(reflecting: ultra).children {
            switch child.label {
            case "submitted": value["submitted"] = (child.value as? UInt64).map { Double($0) } ?? -1
            case "insets": value["insets"] = (child.value as? UIEdgeInsets).map { [$0.top, $0.bottom] } ?? []
            case "viewportSize": value["viewport"] = (child.value as? CGSize).map { [$0.width, $0.height] } ?? []
            case "settlement": value["settlementPending"] = "\(child.value)" != "nil"
            default: break
            }
        }
        value["rows"] = list.items.prefix(16).enumerated().map { index, item -> [String: Any] in
            var row: [String: Any] = ["i": index, "revision": Double(item.revision), "loaded": list.loadedItemView(at: index) != nil]
            if !redacted { row["id"] = item.identity }
            if let chat = item as? ChatUltraRow {
                row["h"] = Double(chat.plan.size.height)
                row["w"] = Double(chat.plan.size.width)
                row["native"] = chat.usesNativeDrawing
            }
            if let frame = list.settledFrame(at: index) { row["settled"] = rect(frame) }
            return row
        }
        return value
    }

    private func firstVisualsObject() -> Any {
        guard let data = try? JSONEncoder().encode(firstVisuals), let object = try? JSONSerialization.jsonObject(with: data) else { return [] as [Any] }
        return object
    }

    private func openingsObject() -> Any {
        guard let data = try? JSONEncoder().encode(openings), let object = try? JSONSerialization.jsonObject(with: data) else { return [] as [Any] }
        return object
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
            // `object`: the row view, to tell a view kept on screen from one
            // made again.
            var entry: [String: Any] = ["id": row.identity, "f": rect(frame), "ready": row.ready, "object": "\(ObjectIdentifier(row.view).hashValue)"]
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
                    hits.append(["row": row.identity, "a": Self.describe(hit.action), "hold": hit.hold, "f": rect(target)])
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
                case let strip as UIScrollView where strip.superview is DiffFileView:
                    // A diff's lines scroll sideways in the diff's own view.
                    native["k"] = "scroller"
                    native["vertical"] = false
                    native["diff"] = true
                    native["content"] = [Double(strip.contentSize.width), Double(strip.contentSize.height)]
                    native["offset"] = [Double(strip.contentOffset.x), Double(strip.contentOffset.y)]
                case let file as DiffFileView:
                    // A diff's rows after the collapse, and those Show more holds back.
                    native["k"] = "diffFile"
                    native["shownRows"] = file.plan?.rows.count ?? -1
                    native["hiddenRows"] = file.plan?.hiddenCount ?? -1
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

    /// A row action as the tests match it: its kind and the ids it carries,
    /// never message text.
    private static func describe(_ action: ChatRowAction) -> String {
        switch action {
        case .copyMessage(let id, _): "copy:\(id)"
        case .toggleGroup(let id): "group:\(id)"
        case .toggleTool(let id): "tool:\(id)"
        case .openMessage(let id): "open:\(id)"
        case .openMessageFile(let id, let file): "openFile:\(id):\(file.suffix(60))"
        case .openFile(let path): "file:\(path.suffix(60))"
        case .option(let title): "option:\(title.prefix(60))"
        case .retry(let localId): "retry:\(localId)"
        case .permission(let tap): "permission:\(tap.permissionId):\(tap.kind)"
        case .questionOption(let toolId, let questionId, let option): "question:\(toolId):\(questionId):\(option)"
        case .questionSubmit(let toolId): "submit:\(toolId)"
        case .diffShowMore(let toolId, let chunk, let file): "showMore:\(toolId):\(chunk):\(file)"
        case .mermaidHeight(let row, let index, _): "mermaidHeight:\(row):\(index)"
        case .openMedia(let id): "media:\(id)"
        case .openArtifact(let artifact): "artifact:\(artifact.id)"
        case .copyMenu: "copyMenu"
        case .selectable: "selectable"
        case .markdownSelectable: "markdownSelectable"
        }
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
    var uncommitted: Int
    var onScreen: Int
    var ready: Int
    var notReady: Int
    var uncovered: Double
    var rigid: Double
    var deviation: Double
    var newestGap: Double
    var touchDelta: Double
    var turn: Double
    var applyMs: Double
    var applySumMs: Double
    var memoryMB: Double
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
    /// The longest one chat apply held the main thread, and all of them
    /// together (measured chat applies only, not the main thread's total).
    var applyMaxMs: Double
    var applyTotalMs: Double
    var applies: Int
    var touches: Int
    var notReadyFrames: Int
    /// The most frames in a row with a row on screen not drawn.
    var notReadyRunMax: Int
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
    var memoryMaxMB: Double
    var kinds: [String]
}

/// Every frame and window, used only on the probe's writer queue.
private final class QALedger: @unchecked Sendable {
    private var frames: [QAFrame] = []
    private var written = 0
    private var windows: [QAWindow] = []
    private let frameURL: URL?
    private let windowURL: URL?
    private let noteURL: URL?
    private let rowURL: URL?
    private var notes: [String] = []
    private var rows: [String] = []

    init(directory: URL?, run: String) {
        frameURL = directory?.appendingPathComponent("\(run)-frames.csv")
        windowURL = directory?.appendingPathComponent("\(run)-windows.json")
        noteURL = directory?.appendingPathComponent("\(run)-notready.jsonl")
        rowURL = directory?.appendingPathComponent("\(run)-rows.jsonl")
        let header = "time,target,callback,flags,finger,offset,presented,distance,dockY,loaded,uncommitted,onScreen,ready,notReady,uncovered,rigid,deviation,newestGap,touchDelta,turn,applyMs,applySumMs,memoryMB\n"
        if let frameURL { try? header.write(to: frameURL, atomically: true, encoding: .utf8) }
    }

    func append(_ batch: [QAFrame], notes lines: [String] = [], rows traced: [String] = []) {
        frames.append(contentsOf: batch)
        notes.append(contentsOf: lines)
        rows.append(contentsOf: traced)
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
        var run = 0, longestRun = 0
        let first = slice[lower]
        for frame in slice {
            run = frame.notReady > 0 ? run + 1 : 0
            longestRun = max(longestRun, run)
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
            // The lead-in frame still follows the previous touch's row.
            if frame.time > first.time, !frame.touchDelta.isNaN { touchDrift = max(touchDrift, abs(frame.touchDelta)) }
        }
        let last = slice[upper]
        windows.append(QAWindow(
            index: windows.count, start: first.time, seconds: last.time - first.time, frames: slice.count,
            expectedMs: expected * 1000,
            gapP50Ms: Self.percentile(50, gaps), gapP95Ms: Self.percentile(95, gaps), gapP99Ms: Self.percentile(99, gaps), gapMaxMs: gaps.max() ?? 0,
            missedFrames: missed, hitches: hitches,
            callbackDelayP99Ms: Self.percentile(99, delays), callbackDelayMaxMs: delays.max() ?? 0,
            pastTargetFrames: slice.filter { $0.callback > $0.target }.count,
            turnMaxMs: slice.map(\.turn).max() ?? 0, turnsOverFrame: slice.filter { expected > 0 && $0.turn > expected * 1000 }.count,
            applyMaxMs: slice.map(\.applyMs).max() ?? 0, applyTotalMs: slice.map(\.applySumMs).reduce(0, +),
            applies: applies, touches: touches,
            notReadyFrames: slice.filter { $0.notReady > 0 }.count, notReadyRunMax: longestRun, notReadyMax: slice.map(\.notReady).max() ?? 0,
            uncoveredMax: slice.map(\.uncovered).max() ?? 0,
            nonRigidMax: nonRigid, restDriftMax: restDrift, awayApplyDriftMax: awayDrift,
            newestGapMin: newestGaps.min() ?? -1, newestGapMax: newestGaps.max() ?? -1,
            touchRowDriftMax: touchDrift,
            dockTravel: last.dockY - first.dockY, offsetTravel: last.presented - first.presented,
            memoryMaxMB: slice.map(\.memoryMB).max() ?? -1,
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
                    String(format: "%.2f", frame.dockY), "\(frame.loaded)", "\(frame.uncommitted)", "\(frame.onScreen)", "\(frame.ready)", "\(frame.notReady)",
                    String(format: "%.1f", frame.uncovered), String(format: "%.2f", frame.rigid), String(format: "%.2f", frame.deviation),
                    String(format: "%.2f", frame.newestGap), String(format: "%.2f", frame.touchDelta), String(format: "%.2f", frame.turn),
                    String(format: "%.2f", frame.applyMs), String(format: "%.2f", frame.applySumMs), String(format: "%.1f", frame.memoryMB),
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
        Self.append(&notes, to: noteURL)
        Self.append(&rows, to: rowURL)
    }

    private static func append(_ lines: inout [String], to url: URL?) {
        guard let url, !lines.isEmpty else { return }
        let text = lines.joined(separator: "\n") + "\n"
        lines.removeAll()
        if !FileManager.default.fileExists(atPath: url.path) { FileManager.default.createFile(atPath: url.path, contents: nil) }
        if let handle = try? FileHandle(forWritingTo: url) {
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: Data(text.utf8))
            try? handle.close()
        }
    }
}
#endif
