import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// EmptyMessages, PendingChatPlaceholder and the deleted state
/// (SessionView.tsx): a column centred in the frame, the glyph, then
/// PendingChatPlaceholder's title, then the lines, each its margin below
/// the last and inside its own padding, with EmptyMessages' status (Retry,
/// Load more or the paging spinner) among them; or the first load's Retry
/// alone in the middle. Its parts come measured; it measures nothing.
public struct ChatPlaceholderLayout: Equatable, Sendable {
    public enum Metrics {
        /// The icon's marginBottom over PendingChatPlaceholder's title.
        public static let titleSpacing: CGFloat = 16
        /// The title's and the status's paddingHorizontal.
        public static let padding: CGFloat = 48
    }

    public struct Line: Equatable, Sendable {
        public var size: CGSize
        /// The previous line's marginBottom.
        public var spacing: CGFloat
        public var padding: CGFloat

        public init(size: CGSize, spacing: CGFloat, padding: CGFloat) {
            self.size = size
            self.spacing = spacing
            self.padding = padding
        }
    }

    /// The status in the column: before the line at `index`.
    public struct Status: Equatable, Sendable {
        public var index: Int
        public var size: CGSize
        public var spacing: CGFloat

        public init(index: Int, size: CGSize, spacing: CGFloat) {
            self.index = index
            self.size = size
            self.spacing = spacing
        }
    }

    public var icon: CGRect?
    public var title: CGRect?
    public var lines: [CGRect]
    public var status: CGRect?

    public init(size: CGSize, icon: CGSize?, title: CGSize?, lines: [Line], status: Status?) {
        typealias M = Metrics
        var items: [CenteredStackLayout.Item] = []
        if let icon { items.append(CenteredStackLayout.Item(.fixed(icon))) }
        if let title { items.append(CenteredStackLayout.Item(.fixed(title), spacingBefore: M.titleSpacing, horizontalPadding: M.padding)) }
        var lineItems = lines.map { CenteredStackLayout.Item(.fixed($0.size), spacingBefore: $0.spacing, horizontalPadding: $0.padding) }
        let status = status.flatMap { $0.index <= lines.count ? $0 : nil }
        if let status {
            lineItems.insert(CenteredStackLayout.Item(.fixed(status.size), spacingBefore: status.spacing, horizontalPadding: M.padding), at: status.index)
        }
        var frames = CenteredStackLayout(.init(size: size, items: items + lineItems)).items[...]
        self.icon = icon == nil ? nil : frames.popFirst()
        self.title = title == nil ? nil : frames.popFirst()
        var placed = Array(frames)
        self.status = status.map { placed.remove(at: $0.index) }
        self.lines = placed
    }

    /// The first load's Retry, centred in a frame of `size`.
    public init(size: CGSize, button: CGSize) {
        icon = nil
        title = nil
        lines = []
        status = CGRect(x: (size.width - button.width) / 2, y: (size.height - button.height) / 2, width: button.width, height: button.height)
    }
}
