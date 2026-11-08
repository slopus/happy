import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Telegram's recording screen, laid over the window while the microphone
/// is held (`TGModernConversationInputMicButton.updateOverlay` and
/// `ChatTextInputPanelNode`'s recording state):
///
///                              ( 🔒 )   ← the lock pill, 122 over the button
///                              (  ⌃ )
///
///     ( ● 0:02,54     ‹ Slide to cancel        (  ◉  ) )
///       ↑ the bar the host gives            ↑ the 110 circle on the button,
///                                             the waves' 244 square round it
///
/// Every frame is in the overlay's space, the window's. The bar's line
/// runs through the button's middle; "Slide to cancel" is centred in what
/// shows of the bar between the clock and the circle, and slides with the
/// finger at half its pace, fading as it reaches the clock.
public struct RecordOverlayLayout: Equatable, Sendable {
    public enum Metrics {
        public static let lockWidth: CGFloat = 40
        public static let lockHeight: CGFloat = 72
        /// The lock pill's middle above the button's.
        public static let lockRaise: CGFloat = 122
        /// The pill shrinks by this much as it locks, to a circle.
        public static let lockShrink: CGFloat = 32
        /// Telegram's `LockView`, its lock and chevron in one 40 by 60
        /// animation, centred in the full pill.
        public static let lockGlyphHeight: CGFloat = 60
        /// It rises this much as it locks (`_lock.transform`), so its stop
        /// lands in the middle of the circle the pill becomes.
        public static let lockGlyphRise: CGFloat = 16
        public static let dotSize: CGFloat = 10
        public static let dotLeft: CGFloat = 16
        public static let clockLeft: CGFloat = 34
        /// Between the chevron and "Slide to cancel".
        public static let cancelGap: CGFloat = 6
        /// The finger's first points left don't move the line.
        public static let cancelThreshold: CGFloat = 8
        /// The line fades out over its last points before the clock.
        public static let cancelFade: CGFloat = 10
    }

    public struct Input: Equatable, Sendable {
        /// The microphone, where it rests.
        public var button: CGRect
        /// The bar the clock and "Slide to cancel" sit in.
        public var bar: CGRect
        public var clock: CGSize
        /// "‹" and "Slide to cancel".
        public var arrow: CGSize
        public var label: CGSize
        /// "Cancel", once locked.
        public var cancel: CGSize
        /// How far left the finger is, zero or more.
        public var cancelTranslation: CGFloat
        /// How closed the lock is, 0 to 1.
        public var lockness: CGFloat
        /// How far the bar has grown out of the button, 0 to 1
        /// (`RecordMotion.barGrowth`).
        public var growth: CGFloat

        public init(button: CGRect, bar: CGRect, clock: CGSize, arrow: CGSize, label: CGSize, cancel: CGSize, cancelTranslation: CGFloat = 0, lockness: CGFloat = 0, growth: CGFloat = 1) {
            self.button = button
            self.bar = bar
            self.clock = clock
            self.arrow = arrow
            self.label = label
            self.cancel = cancel
            self.cancelTranslation = cancelTranslation
            self.lockness = lockness
            self.growth = growth
        }
    }

    /// The bar as it grows out of the button: the button's circle
    /// stretching left along its line into the full bar. Its corners stay
    /// half its height.
    public var bar: CGRect
    /// What the bar holds, the full bar's size, in the growing bar's
    /// space: it is uncovered as the bar grows, never squeezed.
    public var barContent: CGRect
    /// The blue circle and the waves' square, before their transforms.
    public var inner: CGRect
    public var outer: CGRect
    /// The pill's full height, which moves as one with the finger.
    public var lockWrapper: CGRect
    /// The pill in the wrapper's space: 72 tall, a 40 circle when locked.
    public var lockPanel: CGRect
    /// The lock and its chevron (`LockView`) in the panel's space.
    public var lockGlyph: CGRect
    public var dot: CGRect
    public var clock: CGRect
    /// "‹ Slide to cancel" as one, and its parts in the bar's space.
    public var cancelLine: CGRect
    public var cancelArrow: CGRect
    public var cancelLabel: CGRect
    public var cancelLineAlpha: CGFloat
    /// "Cancel", centred where the line was.
    public var cancelButton: CGRect

    public init(_ input: Input) {
        typealias M = Metrics
        let center = CGPoint(x: input.button.midX, y: input.button.midY)
        let lockness = min(1, max(0, input.lockness))

        let innerSide = RecordMotion.Metrics.innerDiameter
        let outerSide = RecordBlob.Metrics.side
        inner = CGRect(x: center.x - innerSide / 2, y: center.y - innerSide / 2, width: innerSide, height: innerSide)
        outer = CGRect(x: center.x - outerSide / 2, y: center.y - outerSide / 2, width: outerSide, height: outerSide)

        lockWrapper = CGRect(
            x: (center.x - M.lockWidth / 2).rounded(.down),
            y: (center.y - M.lockRaise - M.lockHeight / 2).rounded(.down),
            width: M.lockWidth,
            height: M.lockHeight
        )
        // Telegram's pill comes down 40 as it loses 32 of its height: the
        // circle it becomes sits a little below where the pill's foot was.
        lockPanel = CGRect(x: 0, y: M.lockWidth * lockness, width: M.lockWidth, height: M.lockHeight - M.lockShrink * lockness)
        // Centred in the full pill once and left there as the pill
        // shrinks under it, as Telegram adds it.
        lockGlyph = CGRect(
            x: 0,
            y: (M.lockHeight - M.lockGlyphHeight) / 2 - M.lockGlyphRise * lockness,
            width: M.lockWidth,
            height: M.lockGlyphHeight
        )

        let growth = min(1, max(0, input.growth))
        let start = input.button
        func mix(_ a: CGFloat, _ b: CGFloat) -> CGFloat { a + (b - a) * growth }
        let barMinX = mix(start.minX, input.bar.minX)
        let barMinY = mix(start.minY, input.bar.minY)
        bar = CGRect(x: barMinX, y: barMinY, width: mix(start.maxX, input.bar.maxX) - barMinX, height: mix(start.maxY, input.bar.maxY) - barMinY)
        barContent = CGRect(x: input.bar.minX - barMinX, y: input.bar.minY - barMinY, width: input.bar.width, height: input.bar.height)

        let bar = input.bar
        dot = CGRect(x: bar.minX + M.dotLeft, y: center.y - M.dotSize / 2, width: M.dotSize, height: M.dotSize)
        clock = CGRect(x: bar.minX + M.clockLeft, y: center.y - input.clock.height / 2, width: input.clock.width, height: input.clock.height)

        // The lane is what shows of the bar between the clock and the
        // circle: a toolbar's bar ends under the circle, short of the
        // button's edge, so centring in the whole bar (Telegram's panel
        // less 16) would run the line into the clock.
        let laneStart = clock.maxX
        let lane = max(0, min(bar.maxX, inner.minX) - laneStart)
        let lineWidth = input.arrow.width + M.cancelGap + input.label.width
        let lineHeight = max(input.arrow.height, input.label.height)
        let slide = max(0, input.cancelTranslation - M.cancelThreshold)
        cancelLine = CGRect(
            x: laneStart + ((lane - lineWidth - slide) / 2).rounded(.down),
            y: center.y - lineHeight / 2,
            width: lineWidth,
            height: lineHeight
        )
        cancelArrow = CGRect(x: cancelLine.minX, y: center.y - input.arrow.height / 2, width: input.arrow.width, height: input.arrow.height)
        cancelLabel = CGRect(x: cancelArrow.maxX + M.cancelGap, y: center.y - input.label.height / 2, width: input.label.width, height: input.label.height)
        let fadeStart = clock.maxX
        cancelLineAlpha = input.cancelTranslation > M.cancelThreshold
            ? min(1, max(0, (cancelLine.minX - fadeStart) / M.cancelFade))
            : 1
        cancelButton = CGRect(
            x: laneStart + ((lane - input.cancel.width) / 2).rounded(.down),
            y: center.y - input.cancel.height / 2,
            width: input.cancel.width,
            height: input.cancel.height
        )
    }

    /// Telegram's bin (`BinRed`, drawn 40 square): it starts centred on
    /// the dot it grows out of, then centres on the icon it stands in for.
    public static let binSide: CGFloat = 40

    public static func bin(around center: CGPoint) -> CGRect {
        CGRect(x: center.x - binSide / 2, y: center.y - binSide / 2, width: binSide, height: binSide)
    }

    /// The bar a button in a toolbar records in: a capsule as tall as the
    /// button, from `leading` to the button's far edge, under the circle.
    public static func capsule(button: CGRect, leading: CGFloat) -> CGRect {
        let x = min(leading, button.minX)
        return CGRect(x: x, y: button.minY, width: button.maxX - x, height: button.height)
    }
}
