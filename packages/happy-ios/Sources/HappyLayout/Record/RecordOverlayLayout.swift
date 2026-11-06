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
///                                             the 160 ring around it
///
/// Every frame is in the overlay's space, the window's. The bar's line
/// runs through the button's middle; "Slide to cancel" is centred in the
/// bar (less 16, as Telegram's) and slides with the finger at half its
/// pace, fading as it reaches the clock.
public struct RecordOverlayLayout: Equatable, Sendable {
    public enum Metrics {
        public static let lockWidth: CGFloat = 40
        public static let lockHeight: CGFloat = 72
        /// The lock pill's middle above the button's.
        public static let lockRaise: CGFloat = 122
        /// The pill shrinks by this much as it locks, to a circle.
        public static let lockShrink: CGFloat = 32
        /// The lock glyph's box at the pill's top.
        public static let lockGlyph: CGFloat = 40
        public static let lockGlyphTop: CGFloat = 6
        /// The glyph rises this much as it locks.
        public static let lockGlyphRise: CGFloat = 11
        /// The chevron under the lock.
        public static let arrowSize: CGFloat = 12
        public static let arrowTop: CGFloat = 50
        /// The chevron rises this much and is gone by 1/1.6 of the way.
        public static let arrowRise: CGFloat = 39
        public static let arrowFade: CGFloat = 1.6
        public static let dotSize: CGFloat = 10
        public static let dotLeft: CGFloat = 16
        public static let clockLeft: CGFloat = 34
        /// Between the chevron and "Slide to cancel".
        public static let cancelGap: CGFloat = 6
        /// The finger's first points left don't move the line.
        public static let cancelThreshold: CGFloat = 8
        /// The line fades out over its last points before the clock.
        public static let cancelFade: CGFloat = 10
        /// Telegram centres the line in the bar less this.
        public static let laneInset: CGFloat = 16
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

        public init(button: CGRect, bar: CGRect, clock: CGSize, arrow: CGSize, label: CGSize, cancel: CGSize, cancelTranslation: CGFloat = 0, lockness: CGFloat = 0) {
            self.button = button
            self.bar = bar
            self.clock = clock
            self.arrow = arrow
            self.label = label
            self.cancel = cancel
            self.cancelTranslation = cancelTranslation
            self.lockness = lockness
        }
    }

    /// The blue circle and the ring, before their transforms.
    public var inner: CGRect
    public var outer: CGRect
    /// The pill's full height, which moves as one with the finger.
    public var lockWrapper: CGRect
    /// The pill in the wrapper's space: 72 tall, a 40 circle when locked.
    public var lockPanel: CGRect
    /// The lock glyph and the chevron in the panel's space.
    public var lockGlyph: CGRect
    public var arrow: CGRect
    public var arrowAlpha: CGFloat
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
        let outerSide = RecordMotion.Metrics.outerDiameter
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
        lockGlyph = CGRect(
            x: (M.lockWidth - M.lockGlyph) / 2,
            y: M.lockGlyphTop - M.lockGlyphRise * lockness,
            width: M.lockGlyph,
            height: M.lockGlyph
        )
        arrow = CGRect(
            x: (M.lockWidth - M.arrowSize) / 2,
            y: M.arrowTop - M.arrowRise * lockness,
            width: M.arrowSize,
            height: M.arrowSize
        )
        arrowAlpha = max(0, 1 - lockness * M.arrowFade)

        let bar = input.bar
        dot = CGRect(x: bar.minX + M.dotLeft, y: center.y - M.dotSize / 2, width: M.dotSize, height: M.dotSize)
        clock = CGRect(x: bar.minX + M.clockLeft, y: center.y - input.clock.height / 2, width: input.clock.width, height: input.clock.height)

        let lane = max(0, bar.width - M.laneInset)
        let lineWidth = input.arrow.width + M.cancelGap + input.label.width
        let lineHeight = max(input.arrow.height, input.label.height)
        let slide = max(0, input.cancelTranslation - M.cancelThreshold)
        cancelLine = CGRect(
            x: bar.minX + ((lane - lineWidth - slide) / 2).rounded(.down),
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
            x: bar.minX + ((lane - input.cancel.width) / 2).rounded(.down),
            y: center.y - input.cancel.height / 2,
            width: input.cancel.width,
            height: input.cancel.height
        )
    }

    /// The bar a button in a toolbar records in: a capsule as tall as the
    /// button, from `leading` to the button's far edge, under the circle.
    public static func capsule(button: CGRect, leading: CGFloat) -> CGRect {
        let x = min(leading, button.minX)
        return CGRect(x: x, y: button.minY, width: button.maxX - x, height: button.height)
    }
}

/// Telegram's drawn lock (`TGModernConversationInputLockView`), in a 40
/// square: a shackle over a round body with a keyhole. As it locks the
/// shackle comes down 6 and its open leg reaches the body.
public struct RecordLockGlyph: Equatable, Sendable {
    /// The shackle's box: its arch's top, its legs' sides.
    public var shackle: CGRect
    /// Where the closed (left) leg ends, and the open (right) one.
    public var leftLegEnd: CGFloat
    public var rightLegEnd: CGFloat
    public var body: CGRect
    public var keyhole: CGRect
    public var lineWidth: CGFloat

    public init(side: CGFloat = RecordOverlayLayout.Metrics.lockGlyph, lockness: CGFloat, scale: CGFloat) {
        let lockness = min(1, max(0, lockness))
        let mid = side / 2
        let box = CGRect(x: mid - 6, y: 6, width: 12, height: 33)
        shackle = CGRect(x: box.minX, y: box.minY + lockness * 6, width: box.width, height: box.maxY - (box.minY + lockness * 6))
        leftLegEnd = box.midY
        rightLegEnd = box.midY - 6 * (1 - lockness)
        body = CGRect(x: mid - 8, y: side - 18, width: 16, height: 16)
        keyhole = CGRect(x: mid - 2, y: side - 12, width: 4, height: 4)
        lineWidth = scale >= 3 ? 5.0 / 3.0 : 1.5
    }
}
