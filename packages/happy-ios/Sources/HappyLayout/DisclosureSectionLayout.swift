import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// A section that opens in place (DisclosureSectionView), centred: its
/// title and a chevron together in a text action's 40 tall target, and,
/// open, its paragraphs under it.
///
///          Running Happy on a server?  ⌄      the target, centred
///     4                                       (open only)
///     paragraph                               centred
///     8
///     paragraph
///
/// The paragraphs are placed either way, so opening only grows the
/// section's height over them.
public struct DisclosureSectionLayout: Equatable, Sendable {
    public enum Metrics {
        public static let minHeight: CGFloat = TextActionLayout.Metrics.minHeight
        public static let padding: CGFloat = TextActionLayout.Metrics.paddingHorizontal
        public static let chevron: CGFloat = 13
        public static let chevronGap: CGFloat = 6
        public static let bodyGap: CGFloat = 4
        public static let paragraphGap: CGFloat = 8
    }

    /// The title's target, and in it the title and the chevron.
    public var header: CGRect
    public var title: CGRect
    public var chevron: CGRect
    public var paragraphs: [CGRect]
    public var size: CGSize

    public init(width: CGFloat, title: Measurable, paragraphs: [Measurable], expanded: Bool) {
        typealias M = Metrics
        let width = max(0, width)
        let titleSize = title.size(fitting: max(0, width - M.padding * 2 - M.chevronGap - M.chevron))
        let headerSize = CGSize(
            width: min(width, M.padding * 2 + titleSize.width + M.chevronGap + M.chevron),
            height: max(M.minHeight, titleSize.height)
        )
        header = CGRect(x: (width - headerSize.width) / 2, y: 0, width: headerSize.width, height: headerSize.height)
        self.title = CGRect(x: M.padding, y: (headerSize.height - titleSize.height) / 2, width: titleSize.width, height: titleSize.height)
        chevron = CGRect(x: self.title.maxX + M.chevronGap, y: (headerSize.height - M.chevron) / 2, width: M.chevron, height: M.chevron)
        var y = header.maxY + M.bodyGap
        var frames: [CGRect] = []
        for (index, paragraph) in paragraphs.enumerated() {
            if index > 0 { y += M.paragraphGap }
            // The full width, centred in it, so a line measured to fit
            // is never squeezed onto two.
            let height = paragraph.height(fitting: width)
            frames.append(CGRect(x: 0, y: y, width: width, height: height))
            y += height
        }
        self.paragraphs = frames
        size = CGSize(width: width, height: expanded ? (frames.last?.maxY ?? header.maxY) : header.maxY)
    }
}
