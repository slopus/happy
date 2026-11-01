#if DEBUG && canImport(UIKit)
import UIKit

/// A new-work screen the compose trace can read: Happy Agent's new work
/// (`ChatViewController`) and a legacy account's empty chat
/// (`LegacyChatViewController`), which share `NewWorkPanel`.
@MainActor
protocol ComposeTraced: UIViewController {
    /// "composer", "name" or "none": what has the keyboard.
    var traceResponder: String { get }
    /// The composer, riding the keyboard.
    var traceComposer: UIView? { get }
    /// What new work will be, centred over the composer, while it shows.
    var tracePanel: UIView? { get }
    /// The room the panel is centred in: the bar's foot to the composer's
    /// (or its dock's) top.
    var traceRoom: (top: CGFloat, bottom: CGFloat) { get }
}

/// For tracing a new-work screen (`HAPPY_COMPOSE_TRACE`): every frame
/// while it is up or moving, logged as `COMPOSETRACE` with the screen's
/// and the composer's drawn place (their presentation layers), the
/// keyboard's top as its notifications said, who has the keyboard, the
/// transition and the panel's middle; and, as the value of a 1-point
/// element named "compose-trace", what the UI tests check: the keyboard as
/// the push ended, how many frames of the push and of a swipe back had it,
/// how far the panel sits from the middle of its room, and how the push
/// ran (`openingReport`): how late its first frame came, the gaps between
/// the frames after, and how well the composer rode the keyboard, which
/// is read as drawn from the keyboard's own window. Otherwise the keyboard
/// is up from its will-show notification to its will-hide one.
@MainActor
final class ComposeTrace: NSObject {
    static var isOn: Bool { ProcessInfo.processInfo.environment["HAPPY_COMPOSE_TRACE"] != nil }

    private weak var screen: (any ComposeTraced)?
    private var link: CADisplayLink!
    private let element = UIView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
    private let started = CACurrentMediaTime()
    /// The keyboard's top in the window; nil while it is down.
    private var keyboardTop: CGFloat?
    private var appearKeyboard = "none"
    private var hasAppeared = false
    private var pushFrames = 0
    private var pushKeyboardFrames = 0
    private var swipeFrames = 0
    private var swipeDrops = 0
    /// From the push's start until it has ended (the keyboard is up by
    /// then): each frame's gap after the one before, against the display's
    /// own frame time, the keyboard and the composer as drawn, the screen's
    /// left edge and when the frame is shown.
    private var opening: [(gap: CFTimeInterval, nominal: CFTimeInterval, keyboardTop: CGFloat?, composerBottom: CGFloat?, x: CGFloat?, shownAt: CFTimeInterval)] = []
    private var lastTick: CFTimeInterval?
    /// When the screen came into the window, the push starting: frames
    /// count from here.
    private var movingSince: CFTimeInterval?

    init(_ screen: any ComposeTraced) {
        self.screen = screen
        super.init()
        element.isAccessibilityElement = true
        element.accessibilityIdentifier = "compose-trace"
        element.isUserInteractionEnabled = false
        screen.view.addSubview(element)
        link = CADisplayLink(target: self, selector: #selector(tick))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
        link.add(to: .main, forMode: .common)
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardWillChange(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        event("trace start \(type(of: screen))")
    }

    func stop() { link.invalidate() }

    func event(_ what: String) {
        if what.hasPrefix("isAppearing"), movingSince == nil { movingSince = CACurrentMediaTime() }
        NSLog("%@", "COMPOSETRACE t=\(String(format: "%.3f", CACurrentMediaTime() - started)) event \(what)")
    }

    @objc private func keyboardWillChange(_ note: Notification) {
        guard let end = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue,
              let window = screen?.view.window else { return }
        let local = window.convert(end, from: window.screen.coordinateSpace)
        keyboardTop = local.isEmpty || local.minY >= window.bounds.maxY - 1 ? nil : local.minY
        let duration = (note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0
        event("keyboard top=\(keyboardTop.map { "\(Int($0))" } ?? "down") duration=\(duration)")
    }

    func appeared() {
        guard !hasAppeared else { return }
        hasAppeared = true
        if let keyboardTop { appearKeyboard = "\(Int(keyboardTop))" }
        event("didAppear keyboard=\(appearKeyboard) responder=\(screen?.traceResponder ?? "-")")
        report()
    }

    @objc private func tick() {
        defer { lastTick = link.timestamp }
        guard let screen, let window = screen.view.window else { return }
        if let movingSince, !hasAppeared {
            // Not committed yet, the screen isn't drawn: only the gap counts.
            let drawn = screen.view.layer.presentation()
            let shownComposer = drawn == nil ? nil : screen.traceComposer.flatMap { view -> CGFloat? in
                guard let shown = view.layer.presentation(), let root = window.layer.presentation() else { return nil }
                return shown.convert(shown.bounds, to: root).maxY
            }
            opening.append((link.timestamp - max(lastTick ?? movingSince, movingSince), link.duration, drawn == nil ? nil : Self.keyboardTop(in: window),
                            shownComposer, drawn.map { $0.convert(CGPoint.zero, to: nil).x }, link.targetTimestamp))
        }
        let layer = screen.view.layer.presentation() ?? screen.view.layer
        let x = layer.convert(CGPoint.zero, to: nil).x
        let onScreen = keyboardTop != nil
        let coordinator = screen.transitionCoordinator
        let transition = coordinator.map { $0.isCancelled ? "cancelled" : $0.isInteractive ? "interactive" : "animated" } ?? "-"
        let responder = screen.traceResponder
        if coordinator != nil, !hasAppeared {
            pushFrames += 1
            if onScreen { pushKeyboardFrames += 1 }
        }
        if coordinator?.isInteractive == true, hasAppeared {
            swipeFrames += 1
            if !onScreen || responder == "none" { swipeDrops += 1 }
        }
        // As shown, in the screen: the composer may sit in a dock.
        let composer = screen.traceComposer.map { view in
            let shown = view.layer.presentation() ?? view.layer
            return shown.convert(shown.bounds, to: layer)
        }
        let panel = screen.tracePanel.map { ($0.layer.presentation() ?? $0.layer) }
        func f(_ value: CGFloat?) -> String {
            guard let value, value.isFinite, value < 1e6 else { return "-" }
            return String(format: "%.1f", Double(value))
        }
        NSLog("%@", "COMPOSETRACE t=\(String(format: "%.3f", CACurrentMediaTime() - started)) x=\(f(x)) keyboard=\(f(keyboardTop)) composer=\(f(composer?.minY)) cb=\(f(composer.flatMap { _ in opening.last?.composerBottom })) panel=\(f(panel?.frame.midY)) alpha=\(f(panel.map { CGFloat($0.opacity) })) kb=\(f(Self.keyboardTop(in: window))) \(responder) \(transition)")
        report()
    }

    /// The opening's frames: how long from the push's start to its first
    /// drawn frame and how much of the push that had already used up; after
    /// it, the longest gap between two frames (ms) and how many came later
    /// than one and a half display frames; and how far the
    /// composer strayed from riding the keyboard: one animation on the
    /// keyboard's curve and time has, on every frame, come as much of its
    /// way as the keyboard has of its own (the hosted keyboard tests'
    /// rule). The composer's way runs from where it rests over the safe
    /// area, the same distance over that foot as it ends over the keyboard.
    private var openingReport: String {
        // The push's first drawn frame, and every one after it.
        let firstDrawn = opening.firstIndex { $0.x != nil } ?? opening.endIndex
        let first = opening.indices.contains(firstDrawn) ? opening[firstDrawn].shownAt - (movingSince ?? 0) : 0
        let frames = opening[min(firstDrawn + 1, opening.endIndex)...]
        let longest = frames.map(\.gap).max() ?? 0
        let late = frames.filter { $0.gap > $0.nominal * 1.5 }.count
        var stray: CGFloat = 0
        if let window = screen?.view.window {
            let restingFoot = window.bounds.maxY - window.safeAreaInsets.bottom
            // A keyboard read in the top third is a host caught between two.
            let drawn = opening.compactMap { frame in
                frame.keyboardTop.flatMap { top in frame.composerBottom.map { (top, $0) } }
            }.filter { $0.0 > window.bounds.height / 3 }
            if let last = drawn.last, last.0 < window.bounds.maxY - 1 {
                let distance = last.0 - last.1
                let resting = restingFoot - distance
                let keyboardWay = window.bounds.maxY - last.0
                for (top, bottom) in drawn {
                    let progress = (window.bounds.maxY - top) / keyboardWay
                    stray = max(stray, abs(bottom - (resting + (last.1 - resting) * progress)))
                }
            }
        }
        // How much of the push was over by its first drawn frame.
        let width = screen?.view.bounds.width ?? 1
        let skipped = opening.lazy.compactMap(\.x).first.map { 1 - $0 / max(1, width) } ?? 0
        return String(format: "openFrames=%d openFirstMs=%.1f openLongestMs=%.1f openLate=%d openStray=%.1f openSkipped=%.2f", frames.count, first * 1000, longest * 1000, late, Double(stray), Double(skipped))
    }

    /// The keyboard's top as drawn, in `window`: its host view in the
    /// keyboard's own window, as UltraView's keyboard controller finds it.
    private static func keyboardTop(in window: UIWindow) -> CGFloat? {
        let delegateSelector = NSSelectorFromString("keyboardSceneDelegate")
        let windowSelector = NSSelectorFromString("keyboardWindow")
        guard let scene = window.windowScene, scene.responds(to: delegateSelector),
              let delegate = scene.perform(delegateSelector)?.takeUnretainedValue() as? NSObject,
              delegate.responds(to: windowSelector),
              let keyboardWindow = delegate.perform(windowSelector)?.takeUnretainedValue() as? UIWindow,
              !keyboardWindow.isHidden else { return nil }
        func named(_ view: UIView, _ suffixes: [String]) -> Bool {
            let name = NSStringFromClass(type(of: view))
            return name.hasPrefix("UI") && suffixes.contains(where: name.hasSuffix)
        }
        for container in keyboardWindow.subviews where named(container, ["InputSetContainerView", "TrackingWindowView"]) {
            for host in container.subviews where named(host, ["InputSetHostView", "KeyboardItemContainerView"]) && host.bounds.height > 0 {
                let layer = host.layer.presentation() ?? host.layer
                let root = keyboardWindow.layer.presentation() ?? keyboardWindow.layer
                let frame = layer.convert(layer.bounds, to: root).offsetBy(dx: keyboardWindow.frame.minX - window.frame.minX, dy: keyboardWindow.frame.minY - window.frame.minY)
                return min(frame.minY, window.bounds.maxY)
            }
        }
        return nil
    }

    func report() {
        guard let screen else { return }
        screen.view.bringSubviewToFront(element)
        let (top, composerTop) = screen.traceRoom
        var offset = "none"
        if let panel = screen.tracePanel, !panel.isHidden, panel.alpha > 0 {
            offset = String(format: "%.2f", panel.frame.midY - (top + composerTop) / 2)
        }
        element.accessibilityValue = "\(openingReport) appearKeyboard=\(appearKeyboard) pushFrames=\(pushFrames) pushKeyboardFrames=\(pushKeyboardFrames) swipeFrames=\(swipeFrames) swipeDrops=\(swipeDrops) responder=\(screen.traceResponder) panelOffset=\(offset) barBottom=\(Int(top)) composerTop=\(Int(composerTop))"
    }
}
#endif
