import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The Happy CLI home's migration card, inside its group's card: a line
/// icon in an Item's icon slot, level with the title's first line, the
/// title and the body beside it, and the close button's target in the top
/// right corner. The text stops short of that target.
///
///     |16| icon 29 |12| title            |  × 44 |4|
///                       2
///                       body, any lines
///     16
public struct DesktopCardLayout: Equatable, Sendable {
    public enum Metrics {
        public static let padding: CGFloat = 16
        public static let icon: CGFloat = ItemRowLayout.Metrics.iconSize
        public static let iconGap: CGFloat = 12
        /// The title's first line, which the icon is level with.
        public static let titleLine: CGFloat = 22
        public static let bodyGap: CGFloat = 2
        public static let close: CGFloat = 44
        public static let closeGlyph: CGFloat = 17
        public static let closeInset: CGFloat = 4
    }

    public var size: CGSize
    public var icon: CGRect
    public var title: CGRect
    public var body: CGRect
    public var close: CGRect

    public init(width: CGFloat, title: Measurable, body: Measurable) {
        typealias M = Metrics
        let width = max(0, width)
        icon = CGRect(x: M.padding, y: M.padding + (M.titleLine - M.icon) / 2, width: M.icon, height: M.icon)
        close = CGRect(x: width - M.closeInset - M.close, y: M.closeInset, width: M.close, height: M.close)
        let x = icon.maxX + M.iconGap
        let textWidth = max(0, close.minX - x)
        self.title = CGRect(x: x, y: M.padding, width: textWidth, height: title.height(fitting: textWidth))
        self.body = CGRect(x: x, y: self.title.maxY + M.bodyGap, width: textWidth, height: body.height(fitting: textWidth))
        size = CGSize(width: width, height: max(icon.maxY, self.body.maxY) + M.padding)
    }
}
