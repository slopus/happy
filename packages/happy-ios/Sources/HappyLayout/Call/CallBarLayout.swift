import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The voice call's bar across the top of the window, as Telegram's in-call
/// status bar is laid out: it takes the status bar's place and grows past
/// it, and everything under it (the navigation bar first) is pushed down by
/// its height rather than covered. Its words and buttons sit in a row at its
/// foot; the waves overhang its bottom edge.
///
/// Adapted from Telegram-iOS `Display/Source/Navigation/NavigationController.swift`
/// (`containerLayoutUpdated`, the in-call status bar frame) and
/// `TelegramCallsUI/Sources/CallStatusBarNode.swift` (the content row).
public struct CallBarLayout: Equatable, Sendable {
    /// What the top of the screen holds, which decides how far the bar
    /// reaches below the status bar.
    public enum TopEdge: Equatable, Sendable {
        /// A plain status bar (a Home button phone, an iPad).
        case plain
        /// A notch.
        case notch
        /// The Dynamic Island.
        case island

        /// Read from the safe area's top, which is all UIKit says of it:
        /// 20 on a plain phone, 44 to 50 under a notch, 59 and more around
        /// the island.
        public static func from(safeTop: CGFloat) -> TopEdge {
            if safeTop >= 59 { return .island }
            if safeTop >= 44 { return .notch }
            return .plain
        }
    }

    public enum Metrics {
        /// The row at the bar's foot the words and buttons share.
        public static let row: CGFloat = 24
        /// The bar never gets shorter than this, upright or on an iPad.
        public static let minHeight: CGFloat = 40
        /// A phone on its side, where the status bar is gone.
        public static let compactLandscapeMinHeight: CGFloat = 22
        /// How far past the status bar the bar reaches, upright.
        public static let notchExtra: CGFloat = 12
        public static let islandExtra: CGFloat = 20
        /// Between the title and the line after it.
        public static let titleSpacing: CGFloat = 5
        /// A button's glyph, and the box around it that takes a touch.
        public static let glyph: CGFloat = 18
        public static let button: CGFloat = 44
        /// From the bar's side (or the safe area's) to a button's glyph.
        public static let sideInset: CGFloat = 14
    }

    /// The bar: full width from the window's top.
    public let bar: CGRect
    /// What the bar's waves draw in: the bar and the overhang below it.
    public let waves: CGRect
    /// The row the content shares, at the bar's foot.
    public let row: CGRect
    public let title: CGRect
    public let subtitle: CGRect
    /// The mute button's touch box and its glyph, at the leading end.
    public let mute: CGRect
    public let muteGlyph: CGRect
    /// The end (or close) button, at the trailing end.
    public let end: CGRect
    public let endGlyph: CGRect

    /// - Parameters:
    ///   - width: the window's.
    ///   - safeArea: the window's safe area (its top is the status bar's
    ///     height where one shows).
    ///   - statusBar: the status bar's height; 0 where it is hidden.
    ///   - compactWidth: the window's horizontal size class is compact.
    ///   - titleSize, subtitleSize: the words, measured unconstrained.
    public init(width: CGFloat, safeArea: LayoutInsets, statusBar: CGFloat, compactWidth: Bool, landscape: Bool,
                titleSize: CGSize, subtitleSize: CGSize, overhang: CGFloat = CallWaves.overhang) {
        let height = Self.height(safeArea: safeArea, statusBar: statusBar, compactWidth: compactWidth, landscape: landscape)
        bar = CGRect(x: 0, y: 0, width: width, height: height)
        waves = CGRect(x: 0, y: 0, width: width, height: height + overhang)
        row = CGRect(x: 0, y: height - Metrics.row, width: width, height: Metrics.row)

        // The buttons take a touch over the whole bar's height below the
        // status bar's words, so a thumb need not find the row.
        let leading = max(safeArea.left, 0) + Metrics.sideInset
        let trailing = width - max(safeArea.right, 0) - Metrics.sideInset
        let glyphY = row.minY + ((Metrics.row - Metrics.glyph) / 2).rounded(.down)
        muteGlyph = CGRect(x: leading, y: glyphY, width: Metrics.glyph, height: Metrics.glyph)
        endGlyph = CGRect(x: trailing - Metrics.glyph, y: glyphY, width: Metrics.glyph, height: Metrics.glyph)
        let touchTop = max(0, min(row.minY, height - Metrics.button))
        mute = CGRect(x: muteGlyph.midX - Metrics.button / 2, y: touchTop, width: Metrics.button, height: height - touchTop)
        end = CGRect(x: endGlyph.midX - Metrics.button / 2, y: touchTop, width: Metrics.button, height: height - touchTop)

        // Title and line centred across the bar, kept clear of the buttons:
        // the title gives way first, then the line.
        let room = max(0, (end.minX - mute.maxX))
        let spacing = titleSize.width > 0 && subtitleSize.width > 0 ? Metrics.titleSpacing : 0
        let subtitleWidth = min(subtitleSize.width, room)
        let titleWidth = min(titleSize.width, max(0, room - spacing - subtitleWidth))
        let total = titleWidth + spacing + subtitleWidth
        let originX = max(mute.maxX, min((width - total) / 2, end.minX - total)).rounded(.down)
        title = CGRect(x: originX, y: row.minY + ((Metrics.row - titleSize.height) / 2).rounded(.down), width: titleWidth, height: titleSize.height)
        subtitle = CGRect(x: originX + titleWidth + spacing, y: row.minY + ((Metrics.row - subtitleSize.height) / 2).rounded(.down),
                          width: subtitleWidth, height: subtitleSize.height)
    }

    /// The bar's height: the status bar's, never under `minHeight`, and
    /// upright a little more below a notch or the island, as Telegram's.
    public static func height(safeArea: LayoutInsets, statusBar: CGFloat, compactWidth: Bool, landscape: Bool) -> CGFloat {
        let minHeight = compactWidth && landscape ? Metrics.compactLandscapeMinHeight : Metrics.minHeight
        var height = max(statusBar, max(minHeight, safeArea.top))
        if !landscape {
            switch TopEdge.from(safeTop: safeArea.top) {
            case .notch: height += Metrics.notchExtra
            case .island: height += Metrics.islandExtra
            case .plain: break
            }
        }
        return height
    }

    /// What the window's content is left with under the bar: its frame
    /// starts at the bar's foot, so the navigation bar lays itself out
    /// there, and the safe area's top the bar has taken is no longer the
    /// content's to keep clear.
    public static func content(in bounds: CGRect, barHeight: CGFloat) -> CGRect {
        CGRect(x: bounds.minX, y: bounds.minY + barHeight, width: bounds.width, height: max(0, bounds.height - barHeight))
    }
}

/// How the bar comes and goes: it slides down from above the window as the
/// content under it moves down by its height, and back up the same way.
public enum CallBarMotion {
    /// Telegram's `.animated(duration: 0.3, curve: .easeInOut)`.
    public static let duration: TimeInterval = 0.3
    /// Where the bar starts and ends, off the top: its own height and
    /// whatever its waves overhang, so nothing of it shows.
    public static func hiddenOffset(barHeight: CGFloat, overhang: CGFloat = CallWaves.overhang) -> CGFloat {
        -(barHeight + overhang)
    }
}
