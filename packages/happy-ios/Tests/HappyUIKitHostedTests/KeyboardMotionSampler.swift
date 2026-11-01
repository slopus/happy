#if canImport(UIKit)
import UIKit
import XCTest

/// What a chat shows on every display frame while the keyboard moves, read
/// from the presentation layers (what is on the glass), not the models: the
/// keyboard's top, the composer, the newest row and a row the reader is
/// looking at, all in the window's coordinates.
@MainActor
final class KeyboardMotionSampler: NSObject {
    struct Frame {
        var time: CFTimeInterval
        /// The keyboard host's top, or the window's bottom without one.
        var keyboardTop: CGFloat
        var composer: CGRect
        var newest: CGRect?
        var reader: CGRect?
    }

    private let window: UIWindow
    private let composer: () -> UIView?
    private let row: (String) -> UIView?
    private let newestIdentity: () -> String?
    private var readerIdentity: String?
    private var link: CADisplayLink?
    private(set) var frames: [Frame] = []
    /// Whether the keyboard came from the system's keyboard host, not the
    /// layout guide.
    private(set) var sawKeyboardHost = false

    /// `row` finds a list row's view by its identity; `newestIdentity` names
    /// the newest row.
    init(window: UIWindow, composer: @escaping () -> UIView?, newestIdentity: @escaping () -> String?, row: @escaping (String) -> UIView?) {
        self.window = window
        self.composer = composer
        self.newestIdentity = newestIdentity
        self.row = row
    }

    /// The keyboard's notifications while sampling: name, duration and
    /// when, from the start.
    private(set) var notes: [String] = []

    @objc private func noted(_ note: Notification) {
        let duration = note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? -1
        let end = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect)?.minY ?? -1
        let ms = Int(((CACurrentMediaTime() - (frames.first?.time ?? CACurrentMediaTime())) * 1000).rounded())
        notes.append("\(ms)ms \(note.name.rawValue.replacingOccurrences(of: "UIKeyboard", with: "")) duration=\(duration) endTop=\(end)")
    }

    /// Samples every frame from now, following `reader` too.
    func start(reader: String? = nil) {
        frames = []
        notes = []
        let center = NotificationCenter.default
        center.removeObserver(self)
        for name in [UIResponder.keyboardWillChangeFrameNotification, UIResponder.keyboardDidHideNotification, UIResponder.keyboardDidShowNotification] {
            center.addObserver(self, selector: #selector(noted(_:)), name: name, object: nil)
        }
        readerIdentity = reader
        let link = CADisplayLink(target: self, selector: #selector(tick))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
        link.add(to: .main, forMode: .common)
        self.link = link
        tick()
    }

    func stop() {
        link?.invalidate()
        link = nil
        NotificationCenter.default.removeObserver(self)
        tick()
    }

    @objc private func tick() {
        guard let view = composer() else { return }
        frames.append(Frame(
            time: CACurrentMediaTime(),
            keyboardTop: keyboardTop(),
            composer: presented(view),
            newest: newestIdentity().flatMap(row).map(presented),
            reader: readerIdentity.flatMap(row).map(presented)
        ))
    }

    /// Where `view` is drawn now, in the window.
    func presented(_ view: UIView) -> CGRect {
        guard let layer = view.layer.presentation(), let root = window.layer.presentation() else {
            return view.convert(view.bounds, to: window)
        }
        return layer.convert(layer.bounds, to: root)
    }

    /// The keyboard as drawn: its host view in the keyboard's window (the
    /// same lookup UltraView's keyboard controller makes).
    private func keyboardTop() -> CGFloat {
        if let host = Self.keyboardHost(in: window.windowScene),
           let layer = host.layer.presentation(), let root = host.window?.layer.presentation() {
            sawKeyboardHost = true
            let inKeyboardWindow = layer.convert(layer.bounds, to: root)
            let onScreen = inKeyboardWindow.offsetBy(dx: host.window?.frame.minX ?? 0, dy: host.window?.frame.minY ?? 0)
            let local = onScreen.offsetBy(dx: -window.frame.minX, dy: -window.frame.minY)
            return min(local.minY, window.bounds.maxY)
        }
        return window.bounds.maxY
    }

    static func keyboardHost(in scene: UIWindowScene?) -> UIView? {
        let delegateSelector = NSSelectorFromString("keyboardSceneDelegate")
        let windowSelector = NSSelectorFromString("keyboardWindow")
        guard let scene, scene.responds(to: delegateSelector),
              let delegate = scene.perform(delegateSelector)?.takeUnretainedValue() as? NSObject,
              delegate.responds(to: windowSelector),
              let window = delegate.perform(windowSelector)?.takeUnretainedValue() as? UIWindow,
              !window.isHidden else { return nil }
        func named(_ view: UIView, _ suffixes: [String]) -> Bool {
            let name = NSStringFromClass(type(of: view))
            return name.hasPrefix("UI") && suffixes.contains(where: name.hasSuffix)
        }
        for container in window.subviews where named(container, ["InputSetContainerView", "TrackingWindowView"]) {
            for view in container.subviews where named(view, ["InputSetHostView", "KeyboardItemContainerView"]) && view.bounds.height > 0 {
                return view
            }
        }
        return nil
    }

    // MARK: Reading the motion

    /// The frames from the first that moved to the last that moved, with
    /// one resting frame on each side.
    var motion: ArraySlice<Frame> {
        func moved(_ index: Int) -> Bool {
            let a = frames[index - 1], b = frames[index]
            return abs(a.keyboardTop - b.keyboardTop) > 0.01 || abs(a.composer.minY - b.composer.minY) > 0.01
                || abs((a.newest?.maxY ?? 0) - (b.newest?.maxY ?? 0)) > 0.01
        }
        guard frames.count > 1, let first = (1..<frames.count).first(where: moved),
              let last = (1..<frames.count).last(where: moved) else { return frames[...] }
        return frames[(first - 1)...last]
    }

    struct Report: CustomStringConvertible {
        /// Frames the keyboard moved on.
        var frames: Int
        var keyboardTravel: CGFloat
        /// How far the composer strayed from the keyboard's own curve: on
        /// each frame it has come as much of its way as the keyboard has
        /// of its own, as one animation on the keyboard's curve and
        /// duration does.
        var composerOffKeyboard: CGFloat
        /// How far the gap between the newest row and the composer strayed.
        var newestOffComposer: CGFloat?
        /// How far the reader's row strayed from the composer.
        var readerOffComposer: CGFloat?
        /// The largest single-frame moves.
        var keyboardStep: CGFloat
        var composerStep: CGFloat
        var newestStep: CGFloat
        var readerStep: CGFloat
        var description: String {
            "frames=\(frames) travel=\(keyboardTravel) composerOff=\(composerOffKeyboard) newestOff=\(newestOffComposer.map { "\($0)" } ?? "-") readerOff=\(readerOffComposer.map { "\($0)" } ?? "-") steps keyboard=\(keyboardStep) composer=\(composerStep) newest=\(newestStep) reader=\(readerStep)"
        }
    }

    func report() -> Report {
        let frames = Array(motion)
        var report = Report(frames: frames.count, keyboardTravel: 0, composerOffKeyboard: 0, keyboardStep: 0, composerStep: 0, newestStep: 0, readerStep: 0)
        guard let first = frames.first, let last = frames.last else { return report }
        report.keyboardTravel = abs(last.keyboardTop - first.keyboardTop)
        let newestGap = last.newest.map { last.composer.minY - $0.maxY }
        let readerGap = last.reader.map { $0.minY - last.composer.minY }
        let keyboardWay = last.keyboardTop - first.keyboardTop, composerWay = last.composer.maxY - first.composer.maxY
        for (index, frame) in frames.enumerated() {
            let progress = abs(keyboardWay) > 0.5 ? (frame.keyboardTop - first.keyboardTop) / keyboardWay : 1
            let expected = first.composer.maxY + composerWay * progress
            report.composerOffKeyboard = max(report.composerOffKeyboard, abs(frame.composer.maxY - expected))
            if let newestGap, let newest = frame.newest {
                report.newestOffComposer = max(report.newestOffComposer ?? 0, abs(frame.composer.minY - newest.maxY - newestGap))
            }
            if let readerGap, let reader = frame.reader {
                report.readerOffComposer = max(report.readerOffComposer ?? 0, abs(reader.minY - frame.composer.minY - readerGap))
            }
            guard index > 0 else { continue }
            let previous = frames[index - 1]
            report.keyboardStep = max(report.keyboardStep, abs(frame.keyboardTop - previous.keyboardTop))
            report.composerStep = max(report.composerStep, abs(frame.composer.maxY - previous.composer.maxY))
            if let a = previous.newest, let b = frame.newest { report.newestStep = max(report.newestStep, abs(b.maxY - a.maxY)) }
            if let a = previous.reader, let b = frame.reader { report.readerStep = max(report.readerStep, abs(b.minY - a.minY)) }
        }
        return report
    }

    /// Every frame as a line, for a failure's message.
    var log: String {
        guard let start = frames.first?.time else { return "" }
        return (notes + motion.map { frame in
            let ms = Int(((frame.time - start) * 1000).rounded())
            return "\(ms)ms kb=\(r(frame.keyboardTop)) composer=\(r(frame.composer.minY))…\(r(frame.composer.maxY)) newest=\(frame.newest.map { r($0.maxY) } ?? "-") reader=\(frame.reader.map { r($0.minY) } ?? "-")"
        }).joined(separator: "\n")
    }

    private func r(_ value: CGFloat) -> String { String(format: "%.1f", value) }
}
#endif
