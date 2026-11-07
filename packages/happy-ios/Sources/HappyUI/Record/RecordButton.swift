#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// The microphone, as Telegram's voice button: press and hold to talk,
/// let go to send what was said, slide left to throw it away, slide up (or
/// just tap) to keep talking hands-free, then send with the big circle or
/// stop with the pill to have the words as a draft. What was said is
/// written out on the phone (`Dictation`) and handed to the host as text.
///
/// One control for every place it sits, home's toolbar and the chat's
/// composer; only its resting look differs. The recording screen is
/// `RecordOverlay`, over the window; the press is read by `RecordGesture`.
///
/// Adapted from Telegram-iOS `TGModernConversationInputMicButton.m`
/// (`beginTrackingWithTouch`, `continueTrackingWithTouch`,
/// `endTrackingWithTouch`) and `ChatTextInputMediaRecordingButton.swift`.
@MainActor
final class RecordButton: UIControl {
    enum Style {
        /// A bar button: the toolbar draws the glass, this the glyph.
        case toolbar
        /// The composer's round primary button, as send is drawn.
        case composer
    }

    var mode: RecordMode = .dictation {
        didSet { applyMode() }
    }
    enum Result: Equatable {
        /// Let go, the big circle, or the button again while locked: the
        /// words go now.
        case send(String)
        /// Stop while locked (or the app left mid-recording): the words,
        /// as a draft to finish before sending.
        case draft(String)
    }

    /// What was heard, when anything was.
    var onResult: ((Result) -> Void)?
    /// Recording began (true) or ended (false), for the host to fade what
    /// the bar covers, as Telegram's field fades under its recording panel.
    var onRecording: ((Bool) -> Void)?
    /// Where the clock goes while recording, in the window's space.
    var bar: (() -> RecordBar?)?
    /// Whether a press may record now.
    var canRecord: () -> Bool = { true }

    private let style: Style
    private let fill = UIView()
    private let glyph: IconView
    private let spinner = UIActivityIndicatorView(style: .medium)
    private var gesture = RecordGesture()
    private let dictation = Dictation()
    private var overlay: RecordOverlay?
    private var origin: CGPoint = .zero
    private var lastSample: (point: CGPoint, time: TimeInterval)?
    private var velocity: CGPoint = .zero
    /// The press is still the finger's: its moves and its lift count.
    private var following = false
    private enum Phase { case idle, holding, locked, finishing }
    private var phase: Phase = .idle

    init(style: Style) {
        self.style = style
        glyph = IconView(nil, size: style == .toolbar ? 22 : AgentInputCardLayout.Metrics.primaryIconSize)
        super.init(frame: .zero)
        isExclusiveTouch = true
        isMultipleTouchEnabled = false
        fill.isUserInteractionEnabled = false
        fill.isHidden = style != .composer
        addSubview(fill)
        addSubview(glyph)
        spinner.hidesWhenStopped = true
        addSubview(spinner)
        isAccessibilityElement = true
        accessibilityTraits = .button
        accessibilityIdentifier = "record-button"
        applyMode()
        applyColors()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.applyColors() }
        dictation.onLevel = { [weak self] level in self?.overlay?.setLevel(level) }
        NotificationCenter.default.addObserver(self, selector: #selector(resigned), name: UIApplication.didEnterBackgroundNotification, object: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    var isRecording: Bool { phase != .idle }

    override var intrinsicContentSize: CGSize {
        style == .toolbar ? CGSize(width: 44, height: 44) : CGSize(width: 42, height: 42)
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize { intrinsicContentSize }

    private func applyMode() {
        switch mode {
        case .dictation:
            glyph.icon = .ionicons(style == .toolbar ? "mic" : "mic-outline")
            accessibilityLabel = Strings.Record.dictate
            accessibilityHint = Strings.Record.dictateHint
        }
    }

    private func applyColors() {
        fill.backgroundColor = UIColor(Palette.surfaceHighest)
        glyph.tintColor = UIColor(Palette.text)
        spinner.color = UIColor(Palette.text)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        fill.frame = bounds
        fill.layer.cornerRadius = bounds.height / 2
        glyph.frame = bounds
        spinner.center = CGPoint(x: bounds.midX, y: bounds.midY)
    }

    /// Telegram's: a little extra room either side.
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        bounds.insetBy(dx: -10, dy: 0).contains(point)
    }

    // MARK: The press

    override func beginTracking(_ touch: UITouch, with event: UIEvent?) -> Bool {
        guard super.beginTracking(touch, with: event) else { return false }
        // Locked: pressing the button again sends, as Telegram's does.
        if phase == .locked {
            finish(.send)
            return false
        }
        guard phase == .idle, gesture.accepts(at: touch.timestamp), canRecord() else { return false }
        // A voice call has the microphone.
        if CallController.shared.holdsMicrophone {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            return false
        }
        switch Dictation.access() {
        case .granted:
            break
        case .needsAsking:
            // The system asks; the next press records.
            Task { _ = await Dictation.ask() }
            return false
        case .microphoneDenied:
            refuse(Strings.Record.microphoneTitle, Strings.Record.microphoneMessage, settings: true)
            return false
        case .speechDenied:
            refuse(Strings.Record.speechTitle, Strings.Record.speechMessage, settings: true)
            return false
        case .unavailable:
            refuse(Strings.Record.unavailableTitle, Strings.Record.unavailableMessage, settings: false)
            return false
        }
        do {
            try dictation.start()
        } catch {
            refuse(Strings.Record.unavailableTitle, Strings.Record.unavailableMessage, settings: false)
            return false
        }
        origin = touch.location(in: self)
        lastSample = (origin, touch.timestamp)
        velocity = .zero
        gesture.begin(at: touch.timestamp)
        following = true
        phase = .holding
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        presentOverlay()
        return true
    }

    override func continueTracking(_ touch: UITouch, with event: UIEvent?) -> Bool {
        guard super.continueTracking(touch, with: event), following, phase == .holding else { return false }
        let point = touch.location(in: self)
        sample(point, at: touch.timestamp)
        let outcome = gesture.move(CGPoint(x: point.x - origin.x, y: point.y - origin.y))
        overlay?.update(gesture)
        switch outcome {
        case .cancel?:
            following = false
            finish(.cancel)
            return false
        case .lock?:
            following = false
            lock()
            return false
        case .send?, nil:
            return true
        }
    }

    override func endTracking(_ touch: UITouch?, with event: UIEvent?) {
        super.endTracking(touch, with: event)
        guard following, phase == .holding else { return }
        following = false
        let point = touch?.location(in: self) ?? origin
        let time = touch?.timestamp ?? ProcessInfo.processInfo.systemUptime
        if let touch { sample(point, at: touch.timestamp) }
        switch gesture.end(CGPoint(x: point.x - origin.x, y: point.y - origin.y), velocity: velocity, at: time) {
        case .send: finish(.send)
        case .cancel: finish(.cancel)
        case .lock: lock()
        }
    }

    /// The system took the touch (a call, a gesture above): the words are
    /// kept, hands-free, as Telegram locks.
    override func cancelTracking(with event: UIEvent?) {
        super.cancelTracking(with: event)
        guard following, phase == .holding else { return }
        following = false
        lock()
    }

    private func sample(_ point: CGPoint, at time: TimeInterval) {
        if let last = lastSample, time > last.time {
            let dt = time - last.time
            velocity = CGPoint(x: (point.x - last.point.x) / dt, y: (point.y - last.point.y) / dt)
        }
        lastSample = (point, time)
    }

    // MARK: Recording

    private func presentOverlay() {
        guard let window, let scene = window.windowScene else { return }
        let overlay = self.overlay ?? RecordOverlay(scene: scene)
        self.overlay = overlay
        overlay.onSend = { [weak self] in self?.finish(.send) }
        overlay.onStop = { [weak self] in self?.finish(.draft) }
        overlay.onCancel = { [weak self] in self?.finish(.cancel) }
        let frame = convert(bounds, to: nil)
        let bar = bar?() ?? RecordBar(frame: RecordOverlayLayout.capsule(button: frame, leading: 16), cornerRadius: frame.height / 2)
        overlay.present(button: frame, bar: bar, mode: mode)
        overlay.update(gesture)
        onRecording?(true)
        UIView.animate(withDuration: RecordMotion.Metrics.appearFade) {
            self.glyph.alpha = 0
            self.fill.alpha = 0
        }
    }

    private func lock() {
        guard phase == .holding else { return }
        phase = .locked
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        overlay?.lock()
        UIAccessibility.post(notification: .layoutChanged, argument: nil)
    }

    private enum Ending { case send, draft, cancel }

    private func finish(_ ending: Ending) {
        guard phase == .holding || phase == .locked else { return }
        phase = .finishing
        following = false
        overlay?.dismiss(cancelled: ending == .cancel)
        onRecording?(false)
        UIView.animate(withDuration: RecordMotion.Metrics.disappearDuration) {
            self.glyph.alpha = 1
            self.fill.alpha = 1
        }
        if ending == .cancel {
            dictation.cancel()
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
            phase = .idle
            return
        }
        glyph.isHidden = true
        spinner.startAnimating()
        Task { [weak self] in
            guard let self else { return }
            let text = await dictation.finish()
            spinner.stopAnimating()
            glyph.isHidden = false
            phase = .idle
            guard !text.isEmpty else {
                UINotificationFeedbackGenerator().notificationOccurred(.error)
                accessibilityValue = Strings.Record.nothingHeard
                return
            }
            onResult?(ending == .send ? .send(text) : .draft(text))
        }
    }

    /// Off the screen mid-recording: the words are kept, as a draft.
    @objc private func resigned() {
        if phase == .holding || phase == .locked { finish(.draft) }
    }

    /// Taken off the screen while recording (the host went): it stops
    /// and its words go to the host as a draft.
    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil, phase == .holding || phase == .locked { finish(.draft) }
    }

    private func refuse(_ title: String, _ message: String, settings: Bool) {
        UINotificationFeedbackGenerator().notificationOccurred(.error)
        guard var top = window?.rootViewController else { return }
        while let presented = top.presentedViewController, !presented.isBeingDismissed { top = presented }
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        if settings, let url = URL(string: UIApplication.openSettingsURLString) {
            alert.addAction(UIAlertAction(title: Strings.Record.openSettings, style: .default) { _ in UIApplication.shared.open(url) })
        }
        alert.addAction(UIAlertAction(title: Strings.Common.ok, style: settings ? .cancel : .default))
        top.present(alert, animated: true)
    }
}
#endif
