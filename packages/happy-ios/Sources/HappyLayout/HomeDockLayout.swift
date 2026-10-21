import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Home's resting dock (HomeDock.tsx's `safeArea` and `renderComposer`):
/// a one-line capsule at the foot of the screen that opens the composer.
///
///     |16| ( Plan, ask, build…               (↑) ) |16|
///
/// The capsule is 56 tall, 8 below the dock's top and `max(10, safe
/// bottom)` above the screen's foot. Its text starts where the rounded end
/// meets the straight edge (`MobileCollapsedComposerGeometry`); the send
/// button is the composer's 42pt primary action. A scrim reaches up from
/// the screen's foot to the capsule's middle.
public struct HomeDockLayout: Equatable, Sendable {
    public enum Metrics {
        /// `MOBILE_HOME_DOCK_CONTENT_INSET`: what home's content leaves
        /// clear for the dock, above the home indicator.
        public static let contentInset: CGFloat = 108
        public static let paddingHorizontal: CGFloat = 16
        /// `MOBILE_HOME_DOCK_TOP_PADDING`.
        public static let paddingTop: CGFloat = 8
        public static let minPaddingBottom: CGFloat = 10
        /// `composerContent`'s gap between the text and the button.
        public static let contentGap: CGFloat = 4
        /// The arrow in the send button.
        public static let sendIconSize: CGFloat = 16
    }

    public struct Input {
        /// The home screen.
        public var size: CGSize
        public var safeBottom: CGFloat
        /// One device pixel: the capsule's rim.
        public var hairline: CGFloat
        /// `layout.maxWidth`.
        public var maxWidth: CGFloat
        /// The prompt, or the placeholder, on one line.
        public var entry: Measurable

        public init(size: CGSize, safeBottom: CGFloat, hairline: CGFloat, maxWidth: CGFloat = .greatestFiniteMagnitude, entry: Measurable) {
            self.size = size
            self.safeBottom = safeBottom
            self.hairline = hairline
            self.maxWidth = maxWidth
            self.entry = entry
        }
    }

    /// The dock's box, from the top padding to the screen's foot.
    public var dock: CGRect
    /// The scrim behind the dock, from the capsule's middle down.
    public var scrim: CGRect
    /// The capsule, rim included.
    public var composer: CGRect
    /// What a tap opens the composer from (`inputEntry`).
    public var entry: CGRect
    public var entryText: CGRect
    public var send: CGRect

    public init(_ input: Input) {
        typealias M = Metrics
        let geometry = MobileCollapsedComposerGeometry()
        let metrics = MobileComposerMetrics.mobile
        let width = max(0, input.size.width)
        let height = max(0, input.size.height)

        let dockHeight = M.paddingTop + geometry.shellHeight + max(M.minPaddingBottom, input.safeBottom)
        dock = CGRect(x: 0, y: height - dockHeight, width: width, height: dockHeight)
        let scrimTop = M.paddingTop + geometry.shellHeight / 2
        scrim = CGRect(x: 0, y: dock.minY + scrimTop, width: width, height: dockHeight - scrimTop)

        let lane = max(0, width - 2 * M.paddingHorizontal)
        let composerWidth = min(input.maxWidth, lane)
        composer = CGRect(
            x: M.paddingHorizontal + (lane - composerWidth) / 2,
            y: dock.minY + M.paddingTop,
            width: composerWidth,
            height: geometry.shellHeight
        )

        // The rim is inside the capsule, and the row inside the rim.
        let inner = composer.insetBy(dx: input.hairline, dy: input.hairline)
        let contentLeft = inner.minX + geometry.contentPaddingLeft
        let contentRight = inner.maxX - geometry.contentPaddingRight
        let button = metrics.primaryActionSize
        send = CGRect(x: contentRight - button, y: inner.midY - button / 2, width: button, height: button)
        let entryRight = send.minX - metrics.primaryActionMarginLeft - M.contentGap
        entry = CGRect(x: contentLeft, y: inner.minY, width: max(0, entryRight - contentLeft), height: inner.height)

        let textLane = max(0, entry.width - geometry.inputPaddingLeft - geometry.inputPaddingRight)
        let text = input.entry.size(fitting: textLane)
        entryText = CGRect(
            x: entry.minX + geometry.inputPaddingLeft,
            y: entry.midY - text.height / 2,
            width: min(text.width, textLane),
            height: text.height
        )
    }
}

/// The open composer (HomeDock.tsx's focus mode), in the dock's own space:
/// a box the size of the screen whose foot is the screen's foot with the
/// keyboard down. `keyboardShift` moves the whole box up onto the keyboard.
///
///       ▢  MacBook Pro                       ← a picker row, 42 tall
///       ▢  ~/happy                              1 apart, inset 24
///       ▢  No worktree
///       ▢  Claude Code
///                                            ← 22 clear
///     |16| ● Starting Claude Code…   To interrupt press stop |16|
///     |16| [ the composer card ] |16|
///                                            ← safe bottom + 8
///
/// The status line sits in the 22 the rows leave clear, so showing it
/// moves nothing. While the composer opens its shell grows from the
/// capsule's 56 to the card's height and everything above rides on it.
///
/// A bot lives on a computer and nowhere else: making one keeps only the
/// machine row, and the faces it may wear take the place of the rest,
/// lined up with the icon column (`focusConfigFaces`).
public struct HomeDockFocusLayout: Equatable, Sendable {
    public enum Metrics {
        public static let configPaddingHorizontal: CGFloat = 24
        /// `START_PROGRESS_ROW_HEIGHT`.
        public static let progressRowHeight: CGFloat = 18
        /// The rows hold the status line's room open (`paddingBottom`).
        public static let configPaddingBottom: CGFloat = progressRowHeight + 4
        /// `focusConfigGroup`'s gap.
        public static let rowSpacing: CGFloat = 1
        public static let rowMinHeight: CGFloat = 42
        public static let rowPaddingHorizontal: CGFloat = 6
        public static let rowRadius: CGFloat = 12
        /// Between the icon box and the value.
        public static let rowGap: CGFloat = 12
        public static let iconBox: CGFloat = 24
        public static let iconSize: CGFloat = 21
        /// The native trigger's `Spacer(minLength: 8)` after the value.
        public static let valueTrailing: CGFloat = 8
        /// `focusConfigTriggerValue`, the hidden RN copy of the value that
        /// sizes the native trigger: 17 with no line height, so Plex's own
        /// 1.3 em at the designed size.
        public static let triggerLine: CGFloat = 22.1
        public static let composerPaddingHorizontal: CGFloat = 16
        /// Above the safe area, or above the keyboard.
        public static let composerPaddingBottom: CGFloat = 8
        public static let progressPaddingHorizontal: CGFloat = 16
        public static let progressGap: CGFloat = 6
        public static let progressDot: CGFloat = 6
        /// Around the faces a bot may wear.
        public static let facesPaddingHorizontal: CGFloat = 6
        public static let facesPaddingTop: CGFloat = 6
        public static let facesPaddingBottom: CGFloat = 4
    }

    public struct Input {
        public var size: CGSize
        public var safeBottom: CGFloat
        public var maxWidth: CGFloat
        /// The shell's height now: the card's, or less while it opens.
        public var composerHeight: CGFloat
        /// Each picker row's value, on one line.
        public var rows: [Measurable]
        /// One line of `focusConfigTriggerValue` at the text size: what
        /// holds a row up past its 42, whatever the menu draws in it.
        public var triggerLine: CGFloat
        /// "Starting Claude Code…", while a start runs.
        public var progress: Measurable?
        /// "To interrupt press stop", while Stop can stop it.
        public var hint: Measurable?
        /// The faces' words, while a bot is being made.
        public var faces: BotFacePickerLayout.Text?

        public init(
            size: CGSize,
            safeBottom: CGFloat,
            maxWidth: CGFloat = .greatestFiniteMagnitude,
            composerHeight: CGFloat,
            rows: [Measurable],
            triggerLine: CGFloat = Metrics.triggerLine,
            progress: Measurable? = nil,
            hint: Measurable? = nil,
            faces: BotFacePickerLayout.Text? = nil
        ) {
            self.size = size
            self.safeBottom = safeBottom
            self.maxWidth = maxWidth
            self.composerHeight = composerHeight
            self.rows = rows
            self.triggerLine = triggerLine
            self.progress = progress
            self.hint = hint
            self.faces = faces
        }
    }

    public struct Row: Equatable, Sendable {
        public var frame: CGRect
        public var icon: CGRect
        /// The menu's trigger: the rest of the row after the icon.
        public var trigger: CGRect
        public var value: CGRect

        public init(frame: CGRect, icon: CGRect, trigger: CGRect, value: CGRect) {
            self.frame = frame
            self.icon = icon
            self.trigger = trigger
            self.value = value
        }
    }

    public var rows: [Row]
    /// The faces' line, below the rows; it reveals as one more row.
    public var faces: CGRect?
    /// The picker inside that line, and its frames in its own space.
    public var facePicker: CGRect?
    public var facePickerLayout: BotFacePickerLayout?
    /// The composer's shell.
    public var composer: CGRect
    public var progress: CGRect?
    public var progressDot: CGRect?
    public var progressLabel: CGRect?
    public var progressHint: CGRect?

    public init(_ input: Input) {
        typealias M = Metrics
        let width = max(0, input.size.width)
        let height = max(0, input.size.height)

        let composerLane = max(0, width - 2 * M.composerPaddingHorizontal)
        let composerWidth = min(input.maxWidth, composerLane)
        let composerBottom = height - input.safeBottom - M.composerPaddingBottom
        composer = CGRect(
            x: M.composerPaddingHorizontal + (composerLane - composerWidth) / 2,
            y: composerBottom - input.composerHeight,
            width: composerWidth,
            height: input.composerHeight
        )

        if let label = input.progress {
            let row = CGRect(x: M.composerPaddingHorizontal, y: composer.minY - M.progressRowHeight, width: composerLane, height: M.progressRowHeight)
            let content = CGRect(x: composer.minX, y: row.minY, width: composerWidth, height: row.height)
            progress = row
            let dot = CGRect(
                x: content.minX + M.progressPaddingHorizontal,
                y: row.midY - M.progressDot / 2,
                width: M.progressDot,
                height: M.progressDot
            )
            progressDot = dot
            let contentRight = content.maxX - M.progressPaddingHorizontal
            var labelRight = contentRight
            if let hint = input.hint {
                let size = hint.size(fitting: .greatestFiniteMagnitude)
                let frame = CGRect(x: contentRight - size.width, y: row.midY - size.height / 2, width: size.width, height: size.height)
                progressHint = frame
                labelRight = frame.minX - M.progressGap
            } else {
                progressHint = nil
            }
            let labelX = dot.maxX + M.progressGap
            let lane = max(0, labelRight - labelX)
            let size = label.size(fitting: lane)
            progressLabel = CGRect(x: labelX, y: row.midY - size.height / 2, width: min(size.width, lane), height: size.height)
        } else {
            progress = nil
            progressDot = nil
            progressLabel = nil
            progressHint = nil
        }

        let configWidth = min(input.maxWidth, width)
        let rowX = (width - configWidth) / 2 + M.configPaddingHorizontal
        let rowWidth = max(0, configWidth - 2 * M.configPaddingHorizontal)
        let triggerX = rowX + M.rowPaddingHorizontal + M.iconBox + M.rowGap
        let triggerWidth = max(0, rowX + rowWidth - M.rowPaddingHorizontal - triggerX)
        let valueLane = max(0, triggerWidth - M.valueTrailing)
        let values = input.rows.map { $0.size(fitting: valueLane) }
        // RN's row is its 42, the icon's box or the trigger's sizing copy;
        // the menu's own label (the system's body font) is centred in it.
        let heights = values.map { _ in max(M.rowMinHeight, M.iconBox, input.triggerLine) }
        let picker = input.faces.map { BotFacePickerLayout(width: rowWidth - 2 * M.facesPaddingHorizontal, text: $0) }
        let facesHeight = picker.map { M.facesPaddingTop + $0.size.height + M.facesPaddingBottom }
        let lines = heights + (facesHeight.map { [$0] } ?? [])
        let total = lines.reduce(0, +) + CGFloat(max(0, lines.count - 1)) * M.rowSpacing
        var y = composer.minY - M.configPaddingBottom - total
        rows = zip(values, heights).map { value, rowHeight in
            let frame = CGRect(x: rowX, y: y, width: rowWidth, height: rowHeight)
            y += rowHeight + M.rowSpacing
            return Row(
                frame: frame,
                icon: CGRect(x: rowX + M.rowPaddingHorizontal, y: frame.midY - M.iconBox / 2, width: M.iconBox, height: M.iconBox),
                trigger: CGRect(x: triggerX, y: frame.minY, width: triggerWidth, height: rowHeight),
                value: CGRect(x: triggerX, y: frame.midY - value.height / 2, width: min(value.width, valueLane), height: value.height)
            )
        }
        if let picker, let facesHeight {
            let line = CGRect(x: rowX, y: y, width: rowWidth, height: facesHeight)
            faces = line
            facePicker = CGRect(
                x: line.minX + M.facesPaddingHorizontal,
                y: line.minY + M.facesPaddingTop,
                width: picker.size.width,
                height: picker.size.height
            )
            facePickerLayout = picker
        } else {
            faces = nil
            facePicker = nil
            facePickerLayout = nil
        }
    }

    /// How far the dock rides up on the keyboard: the dock's foot follows
    /// the keyboard's top once it is above the safe area
    /// (`translateY: keyboard.height + safeArea.bottom * progress`).
    public static func keyboardShift(keyboardTop: CGFloat, size: CGSize, safeBottom: CGFloat) -> CGFloat {
        min(0, keyboardTop - (size.height - safeBottom))
    }
}

/// Session | Bot, held at the top of the screen over the dimmed list
/// (HomeDock.tsx `focusHeader`): it decides what everything below is for.
/// A bot's lede sits beneath it. Only where the computer can make bots.
///
///              ( Session | Bot )            ← safe top + 8, at most 260
///       Bots are virtual colleagues great   ← 10 below, at most 340
///         for recurring work like …
public struct HomeDockHeaderLayout: Equatable, Sendable {
    public enum Metrics {
        public static let paddingTop: CGFloat = 8
        public static let paddingHorizontal: CGFloat = 24
        public static let gap: CGFloat = 10
        public static let segmentMaxWidth: CGFloat = 260
        /// `NATIVE_SEGMENTED_CONTROL_HEIGHT`.
        public static let segmentHeight: CGFloat = 32
        public static let ledeMaxWidth: CGFloat = 340
    }

    public struct Input {
        public var width: CGFloat
        public var safeTop: CGFloat
        public var maxWidth: CGFloat
        /// The bot's lede, centred; nil for a session.
        public var lede: Measurable?

        public init(width: CGFloat, safeTop: CGFloat, maxWidth: CGFloat = .greatestFiniteMagnitude, lede: Measurable? = nil) {
            self.width = width
            self.safeTop = safeTop
            self.maxWidth = maxWidth
            self.lede = lede
        }
    }

    /// The control and the lede together: what reveals and refuses.
    public var content: CGRect
    public var segment: CGRect
    public var lede: CGRect?

    public init(_ input: Input) {
        typealias M = Metrics
        let lane = max(0, input.width - 2 * M.paddingHorizontal)
        let contentWidth = min(input.maxWidth, lane)
        let left = M.paddingHorizontal + (lane - contentWidth) / 2
        let top = input.safeTop + M.paddingTop

        let segmentWidth = min(M.segmentMaxWidth, contentWidth)
        segment = CGRect(x: left + (contentWidth - segmentWidth) / 2, y: top, width: segmentWidth, height: M.segmentHeight)
        var bottom = segment.maxY
        if let text = input.lede {
            let ledeLane = Self.ledeWidth(width: input.width, maxWidth: input.maxWidth)
            let size = text.size(fitting: ledeLane)
            let width = min(size.width, ledeLane)
            let frame = CGRect(x: left + (contentWidth - width) / 2, y: segment.maxY + M.gap, width: width, height: size.height)
            lede = frame
            bottom = frame.maxY
        } else {
            lede = nil
        }
        content = CGRect(x: left, y: top, width: contentWidth, height: bottom - top)
    }

    /// The lane the lede wraps in on a screen `width` wide: what to measure
    /// it at ahead of the layout.
    public static func ledeWidth(width: CGFloat, maxWidth: CGFloat = .greatestFiniteMagnitude) -> CGFloat {
        typealias M = Metrics
        let lane = max(0, width - 2 * M.paddingHorizontal)
        return min(M.ledeMaxWidth, min(maxWidth, lane))
    }
}

/// How the composer opens and closes (HomeDock.tsx's `focusPresentation`):
/// every piece is a function of one progress value, 0 closed to 1 open.
public struct HomeDockFocusMotion: Equatable, Sendable {
    /// Opening waits a frame for the modal, then runs 340ms ease-out.
    public static let openDelay: Double = 0.016
    public static let openDuration: Double = 0.34
    /// Closing runs 180ms ease-in from wherever it got to.
    public static let closeDuration: Double = 0.18
    /// How long the open waits for the card's text height, measured off
    /// the main thread, before it runs on the height it has: the shell
    /// grows to the text's height rather than retargeting on the way.
    public static let heightWait: Double = 0.032

    /// The frame's wait before the open runs, less the time spent waiting
    /// for the height: that wait let the modal land already.
    public static func openDelay(afterWaiting waited: Double) -> Double {
        max(0, openDelay - max(0, waited))
    }
    /// The capsule the shell grows from.
    public static let collapsedHeight: CGFloat = 56

    public var progress: CGFloat

    public init(progress: CGFloat) {
        self.progress = progress
    }

    /// `Easing.out(Easing.cubic)`.
    public static func easeOut(_ t: Double) -> Double {
        let clamped = min(1, max(0, t))
        return 1 - pow(1 - clamped, 3)
    }

    /// `Easing.in(Easing.cubic)`.
    public static func easeIn(_ t: Double) -> Double {
        let clamped = min(1, max(0, t))
        return clamped * clamped * clamped
    }

    /// `interpolate(progress, [start, end], [0, 1], CLAMP)`.
    static func ramp(_ value: CGFloat, _ start: CGFloat, _ end: CGFloat) -> CGFloat {
        min(1, max(0, (value - start) / (end - start)))
    }

    /// The blur and dim behind: in by 0.35.
    public var backdropAlpha: CGFloat {
        Self.ramp(progress, 0, 0.35)
    }

    /// Row `index` (from the top) fades in and rises 10pt, each a beat
    /// after the one above.
    public func row(_ index: Int) -> (alpha: CGFloat, offsetY: CGFloat) {
        let start = 0.18 + CGFloat(index) * 0.09
        let reveal = Self.ramp(progress, start, start + 0.28)
        return (reveal, 10 * (1 - reveal))
    }

    /// The shell's height on the way from the capsule to `full`.
    public func composerHeight(full: CGFloat) -> CGFloat {
        let p = min(1, max(0, progress))
        return Self.collapsedHeight + (full - Self.collapsedHeight) * p
    }

    public var composerAlpha: CGFloat {
        0.72 + 0.28 * Self.ramp(progress, 0, 0.12)
    }

    public var composerScaleX: CGFloat {
        0.96 + 0.04 * min(1, max(0, progress))
    }

    // The card's text and action row rise in their own beats:
    // `AgentInputCardReveal`, at this same progress.
}

/// The resting dock fading in as it goes from hidden to shown. This goes
/// past happy-app, whose MainView mounts HomeDock at once and whose
/// HomeDock is `display: 'none'` while the composer is open; the port was
/// asked for it.
///
/// It has two parts: the capsule's surface (its blur, frost, rim and
/// shadow) and what is on it and around it (the prompt, the send button,
/// the scrim).
public struct HomeDockFade: Equatable, Sendable {
    /// What the dock comes back from.
    public enum Origin: Equatable, Sendable {
        /// Home's content came in (its first state on launch, or a state
        /// with a dock after Link Your Computer).
        case appearing
        /// The open composer closed: its shell has just shrunk back to the
        /// capsule in `HomeDockFocusMotion.closeDuration`, an empty capsule
        /// at `composerAlpha` 0.72, and gone.
        case focus
    }

    /// The first show: from nothing, 220ms ease-out.
    public static let appearDuration: Double = 0.22
    /// Back from the composer, in the close's own 180ms, ease-out: the
    /// surface from the closed shell's 0.72, so it doesn't dip, and the
    /// prompt and the button from nothing, as the shell had none. It starts
    /// once the close has ended, so the two never overlap.
    public static let returnDuration: Double = HomeDockFocusMotion.closeDuration

    /// The surface's presence when the fade starts.
    public var surfaceFrom: CGFloat
    /// The prompt's, the button's and the scrim's.
    public var contentFrom: CGFloat
    public var duration: Double

    public init(surfaceFrom: CGFloat, contentFrom: CGFloat, duration: Double) {
        self.surfaceFrom = surfaceFrom
        self.contentFrom = contentFrom
        self.duration = duration
    }

    /// The fade for the dock going from hidden to shown, or nil to show it
    /// at once: off a window (nothing sees it, and a home that comes back
    /// from a pushed screen with its dock showing never fades again) or
    /// with Reduce Motion on.
    public static func shown(from origin: Origin, onWindow: Bool, reduceMotion: Bool) -> HomeDockFade? {
        guard onWindow, !reduceMotion else { return nil }
        switch origin {
        case .appearing:
            return HomeDockFade(surfaceFrom: 0, contentFrom: 0, duration: appearDuration)
        case .focus:
            return HomeDockFade(surfaceFrom: HomeDockFocusMotion(progress: 0).composerAlpha, contentFrom: 0, duration: returnDuration)
        }
    }

    /// How present each part is `elapsed` seconds in, each from where it
    /// starts to 1 on the same curve.
    public func presence(at elapsed: Double) -> (surface: CGFloat, content: CGFloat) {
        guard duration > 0 else { return (1, 1) }
        let eased = CGFloat(HomeDockFocusMotion.easeOut(elapsed / duration))
        return (surfaceFrom + (1 - surfaceFrom) * eased, contentFrom + (1 - contentFrom) * eased)
    }

    public func isFinished(at elapsed: Double) -> Bool {
        elapsed >= duration
    }
}

/// A refused press while a session starts: two beats pointing at Stop
/// (`refusalFlash`), each `withTiming`'s default ease-in-out.
public enum HomeDockRefusal {
    /// (target, duration) from 0.
    public static let flash: [(value: CGFloat, duration: Double)] = [(1, 0.09), (0, 0.13), (1, 0.09), (0, 0.34)]
    // A refused control's shake (`SHAKE_KEYFRAMES`) is
    // `ComposerShake.refusal`.

    /// The flash at `time` seconds after the refusal.
    public static func flash(at time: Double) -> CGFloat {
        var start = 0.0
        var from: CGFloat = 0
        for step in flash {
            if time < start + step.duration {
                let t = (time - start) / step.duration
                return from + (step.value - from) * CGFloat(easeInOutQuad(t))
            }
            start += step.duration
            from = step.value
        }
        return 0
    }

    /// The whole flash's length.
    public static var flashDuration: Double {
        flash.reduce(0) { $0 + $1.duration }
    }

    /// `Easing.inOut(Easing.quad)`, Reanimated's `withTiming` default.
    static func easeInOutQuad(_ t: Double) -> Double {
        let t = min(1, max(0, t))
        return t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
    }
}
