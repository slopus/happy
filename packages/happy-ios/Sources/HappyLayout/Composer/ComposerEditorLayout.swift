import CoreGraphics

/// The composer's text full screen, as Telegram's input expands once it
/// is past the lines the card shows: the text from the safe area's top to
/// the keyboard, and the button that puts it back in the card at its top
/// right, where the card's expand button was.
///
///     ┌ safe area ──────────────────────────────┐
///     │ 16 text ·····························[⤡] 8│ 8 down; the button 4
///     │    ······························· 16 │ the lines clear of it
///     │    ·····································│
///     │    ·····································│ 8 above the keyboard
///     └ keyboard (or the safe area's bottom) ───┘
public struct ComposerEditorLayout: Equatable, Sendable {
    public enum Metrics {
        public static let textInset: CGFloat = 16
        public static let textTop: CGFloat = 8
        public static let textBottom: CGFloat = 8
        public static let collapseSize: CGFloat = 44
        public static let collapseIconSize: CGFloat = 18
        public static let collapseTop: CGFloat = 4
        public static let collapseTrailing: CGFloat = 8
    }

    public struct Insets: Equatable, Sendable {
        public var top: CGFloat
        public var left: CGFloat
        public var bottom: CGFloat
        public var right: CGFloat

        public init(top: CGFloat = 0, left: CGFloat = 0, bottom: CGFloat = 0, right: CGFloat = 0) {
            self.top = top
            self.left = left
            self.bottom = bottom
            self.right = right
        }
    }

    public var collapse: CGRect
    /// The text view, the safe area's width less 16 each side.
    public var text: CGRect
    /// What the text's first lines keep clear of for `collapse`, in the
    /// text's own coordinates (an exclusion path): the lines under it run
    /// the full width.
    public var collapseClearance: CGRect

    /// `keyboardTop` is the keyboard's top in the screen's bounds; nil
    /// while it is down.
    public init(size: CGSize, safeArea: Insets, keyboardTop: CGFloat?) {
        typealias M = Metrics
        let left = safeArea.left
        let right = size.width - safeArea.right
        let bottom = min(size.height - safeArea.bottom, keyboardTop ?? .greatestFiniteMagnitude)
        collapse = CGRect(
            x: right - M.collapseTrailing - M.collapseSize,
            y: safeArea.top + M.collapseTop,
            width: M.collapseSize,
            height: M.collapseSize
        )
        let textX = left + M.textInset
        let textY = safeArea.top + M.textTop
        text = CGRect(
            x: textX,
            y: textY,
            width: max(0, right - M.textInset - textX),
            height: max(0, bottom - M.textBottom - textY)
        )
        collapseClearance = CGRect(
            x: collapse.minX - textX,
            y: 0,
            width: max(0, text.maxX - collapse.minX),
            height: max(0, collapse.maxY - textY)
        )
    }
}
