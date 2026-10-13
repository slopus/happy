import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// What's New's navigation title (app/(app)/_layout.tsx, `changelog`):
/// the title, then the mouse-on-the-phone picture, 6 apart, centred on one
/// line.
///
///     What's New |6| 🐭 40×40
public struct ChangelogTitleLayout: Equatable, Sendable {
    public enum Metrics {
        public static let gap: CGFloat = 6
        public static let imageSize: CGFloat = 40
    }

    public var size: CGSize
    public var title: CGRect
    public var image: CGRect

    /// `maxWidth` is what the navigation bar offers; the title gives way.
    public init(title: Measurable, maxWidth: CGFloat) {
        typealias M = Metrics
        let titleSize = title.size(fitting: max(0, maxWidth - M.gap - M.imageSize))
        let height = max(titleSize.height, M.imageSize)
        self.title = CGRect(x: 0, y: (height - titleSize.height) / 2, width: titleSize.width, height: titleSize.height)
        image = CGRect(x: self.title.maxX + M.gap, y: (height - M.imageSize) / 2, width: M.imageSize, height: M.imageSize)
        size = CGSize(width: image.maxX, height: height)
    }
}

/// A message centred on an otherwise empty screen, 40 in from every edge
/// (changelog.tsx `emptyState`).
public struct CenteredMessageLayout: Equatable, Sendable {
    public enum Metrics {
        public static let padding: CGFloat = 40
    }

    public var message: CGRect

    public init(size: CGSize, safeArea: LayoutInsets, message: Measurable) {
        let padding = Metrics.padding
        let width = max(0, size.width - safeArea.horizontal - padding * 2)
        let height = max(0, size.height - safeArea.vertical - padding * 2)
        let text = message.size(fitting: width)
        self.message = CGRect(
            x: safeArea.left + padding + (width - text.width) / 2,
            y: safeArea.top + padding + (height - text.height) / 2,
            width: text.width,
            height: text.height
        )
    }
}
