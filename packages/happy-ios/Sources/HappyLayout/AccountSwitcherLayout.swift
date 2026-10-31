import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// A single line for the account picture, name and menu chevron.
public struct AccountSwitcherLayout: Equatable, Sendable {
    public enum Metrics {
        public static let height: CGFloat = 36
        /// The glass capsule's inset around what it holds.
        public static let leading: CGFloat = 4
        public static let trailing: CGFloat = 10
        public static let picture: CGFloat = 28
        public static let pictureGap: CGFloat = 8
        public static let chevronGap: CGFloat = 4
    }

    public var size: CGSize
    public var picture: CGRect
    public var title: CGRect
    public var chevron: CGRect

    /// Space left after the navigation bar's margins and trailing actions.
    public static func availableWidth(barWidth: CGFloat, safeArea: LayoutInsets, trailingItems: Int) -> CGFloat {
        max(0, barWidth - safeArea.left - safeArea.right - 32 - CGFloat(trailingItems) * 48 - 8)
    }

    public init(title: CGSize, chevron: CGSize, maxWidth: CGFloat = .greatestFiniteMagnitude) {
        typealias M = Metrics
        let textX = M.leading + M.picture + M.pictureGap
        let fixed = textX + M.chevronGap + chevron.width + M.trailing
        let room = max(0, maxWidth - fixed)
        let titleWidth = min(title.width, room)
        size = CGSize(width: (fixed + titleWidth).rounded(.up), height: M.height)
        picture = CGRect(x: M.leading, y: (M.height - M.picture) / 2, width: M.picture, height: M.picture)
        let top = ((M.height - title.height) / 2).rounded()
        self.title = CGRect(x: textX, y: top, width: titleWidth, height: title.height)
        self.chevron = CGRect(x: textX + titleWidth + M.chevronGap, y: (top + (title.height - chevron.height) / 2).rounded(), width: chevron.width, height: chevron.height)
    }
}
