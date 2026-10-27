import CoreGraphics

/// A conversation's pictures side by side, one a screen wide, `gap` apart
/// as Photos keeps them: the paging scroll view is a gap wider than the
/// screen, half a gap off each side, so each page is centred in it.
public struct StemCellPicturePagerLayout: Equatable, Sendable {
    public static let gap: CGFloat = 20

    public var pager: CGRect
    public var contentSize: CGSize
    public var pageWidth: CGFloat
    private var size: CGSize

    public init(size: CGSize, count: Int) {
        self.size = size
        pageWidth = size.width + Self.gap
        pager = CGRect(x: -Self.gap / 2, y: 0, width: pageWidth, height: size.height)
        contentSize = CGSize(width: pageWidth * CGFloat(max(1, count)), height: size.height)
    }

    /// Page `index` inside the pager.
    public func page(_ index: Int) -> CGRect {
        CGRect(x: CGFloat(index) * pageWidth + Self.gap / 2, y: 0, width: size.width, height: size.height)
    }

    /// The pager's offset with page `index` in view.
    public func offset(_ index: Int) -> CGFloat { CGFloat(index) * pageWidth }

    /// The page most in view at `offset`, within the `count` there are.
    public func index(at offset: CGFloat, count: Int) -> Int {
        guard pageWidth > 0, count > 0 else { return 0 }
        return min(count - 1, max(0, Int((offset / pageWidth).rounded())))
    }
}

/// A picture dragged up or down to close, as Photos and Telegram do: it
/// follows the finger, shrinking a little, while the black around it
/// fades; let go far or fast enough, it goes the way it was going.
public struct StemCellPictureDismissal: Equatable, Sendable {
    /// How far, as a share of the screen's height, takes the ground away.
    public static let fadeDistance: CGFloat = 0.5
    /// The size it shrinks to at most.
    public static let minScale: CGFloat = 0.8
    /// Let go past this far, or flung faster than `closingSpeed`, it closes.
    public static let closingDistance: CGFloat = 100
    public static let closingSpeed: CGFloat = 800

    /// 0 resting, 1 at `fadeDistance` and past.
    public var progress: CGFloat
    public var groundAlpha: CGFloat
    public var scale: CGFloat
    public var closes: Bool

    /// `translation` and `velocity` are the finger's along the screen's height.
    public init(translation: CGFloat, velocity: CGFloat, height: CGFloat) {
        progress = height > 0 ? min(1, abs(translation) / (height * Self.fadeDistance)) : 0
        groundAlpha = 1 - progress
        scale = 1 - (1 - Self.minScale) * progress
        // Flung back toward the middle, it stays, however far it was.
        let flungBack = translation != 0 && velocity != 0 && (translation > 0) != (velocity > 0) && abs(velocity) > Self.closingSpeed
        closes = !flungBack && (abs(translation) > Self.closingDistance || (abs(velocity) > Self.closingSpeed && abs(translation) > 10))
    }
}

/// What a Stem Cell conversation keeps around its composer: home's dock
/// scrim (`HeaderScrimView`, `edge: .bottom`), whole from the card's top to
/// the foot and feathered over the 36 above it, so what scrolls on under
/// the card has faded and blurred out by the time it meets it, never cut
/// along its edge (the header's, upside down; it comes in as the
/// transcript scrolls away from its end, `HeaderScrim.presence`); and
/// desktop's way back to the newest message (`.happy-message-list__jump`),
/// a 32 circle centred 12 above where the list ends, drawn over the
/// scrim's feather.
public struct StemCellChatFootLayout: Equatable, Sendable {
    public enum Metrics {
        /// The list's gap above the card.
        public static let listGap: CGFloat = 8
        public static let jumpSize: CGFloat = 32
        public static let jumpGap: CGFloat = 12
        public static let jumpIcon: CGFloat = 16
        /// `box-shadow: 0 2px 8px var(--shadow-color)`.
        public static let jumpShadowOffset: CGFloat = 2
        public static let jumpShadowRadius: CGFloat = 4
        public static let jumpShadowOpacity: CGFloat = 0.12
    }

    public var scrim: CGRect
    public var jump: CGRect

    /// `card` is the composer's frame in a screen of `size`.
    public init(size: CGSize, card: CGRect) {
        typealias M = Metrics
        let top = max(0, card.minY - M.listGap)
        let scrimTop = max(0, card.minY - HeaderScrim.rampPoints)
        scrim = CGRect(x: 0, y: scrimTop, width: size.width, height: max(0, size.height - scrimTop))
        jump = CGRect(x: ((size.width - M.jumpSize) / 2).rounded(), y: top - M.jumpGap - M.jumpSize, width: M.jumpSize, height: M.jumpSize)
    }

    /// Desktop shows the way back once the reader is more than a third of
    /// the list's height from its end.
    public static func showsJump(distanceFromEnd: CGFloat, viewport: CGFloat) -> Bool {
        viewport > 0 && distanceFromEnd > viewport / 3
    }
}
