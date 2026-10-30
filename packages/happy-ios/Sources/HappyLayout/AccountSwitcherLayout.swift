import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Home's account switcher, alone at the bar's left: the active account's
/// picture, its name with the connection under it while it isn't live,
/// and a chevron that says it opens a menu. The name shortens before the
/// switcher grows past `maxWidth`, so the right's buttons always fit.
///
///     |◉| Steve ⌄
///     |◉| connecting
public struct AccountSwitcherLayout: Equatable, Sendable {
    public enum Metrics {
        public static let height: CGFloat = 36
        /// The glass capsule's inset around what it holds.
        public static let leading: CGFloat = 4
        public static let trailing: CGFloat = 10
        public static let picture: CGFloat = 28
        public static let pictureGap: CGFloat = 8
        public static let chevronGap: CGFloat = 4
        /// The widest it gets: about half a phone's bar.
        public static let maxWidth: CGFloat = 200
    }

    public var size: CGSize
    public var picture: CGRect
    public var title: CGRect
    public var subtitle: CGRect?
    public var chevron: CGRect

    /// `title`, `subtitle` and `chevron` as measured on one line each.
    public init(title: CGSize, subtitle: CGSize?, chevron: CGSize, maxWidth: CGFloat = Metrics.maxWidth) {
        typealias M = Metrics
        let textX = M.leading + M.picture + M.pictureGap
        let fixed = textX + M.chevronGap + chevron.width + M.trailing
        let room = max(0, min(maxWidth, M.maxWidth) - fixed)
        let titleWidth = min(title.width, room)
        let subtitleWidth = min(subtitle?.width ?? 0, room)
        let textWidth = max(titleWidth + M.chevronGap + chevron.width, subtitleWidth)
        size = CGSize(width: (textX + textWidth + M.trailing).rounded(.up), height: M.height)
        picture = CGRect(x: M.leading, y: (M.height - M.picture) / 2, width: M.picture, height: M.picture)
        let textHeight = title.height + (subtitle?.height ?? 0)
        let top = ((M.height - textHeight) / 2).rounded()
        self.title = CGRect(x: textX, y: top, width: titleWidth, height: title.height)
        self.subtitle = subtitle.map { CGRect(x: textX, y: top + title.height, width: subtitleWidth, height: $0.height) }
        self.chevron = CGRect(x: textX + titleWidth + M.chevronGap, y: (top + (title.height - chevron.height) / 2).rounded(), width: chevron.width, height: chevron.height)
    }
}
