import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// A vault's upload row: a card row whose subtitle ("Uploading · 45%")
/// has a progress bar under it, as wide as the text column.
///
///     |16| tile |12| name …………………………………… |16|
///                   Uploading · 45%
///                   |6|
///                   ███████████░░░░░░░░░ 3 tall
public struct VaultUploadRowLayout: Equatable, Sendable {
    public enum Metrics {
        public static let barGap: CGFloat = 6
        public static let barHeight: CGFloat = 3
    }

    public var row: CardRowLayout
    /// The subtitle's own text, above the bar.
    public var subtitle: CGRect
    /// The whole track; `fill` the part sent.
    public var track: CGRect
    public var fill: CGRect

    public init(width: CGFloat, maxWidth: CGFloat = .greatestFiniteMagnitude, place: CardPlace, leading: CGSize, title: Measurable, subtitle: Measurable,
                fraction: Double, titleLine: CGFloat? = nil, hairline: CGFloat, scale: CGFloat = 1) {
        typealias M = Metrics
        let room = M.barGap + M.barHeight
        let text = subtitle
        let withBar = Measurable { width in
            let size = text.size(fitting: width)
            return CGSize(width: size.width, height: size.height + room)
        }
        row = CardRowLayout(width: width, maxWidth: maxWidth, place: place, leading: leading, title: title, subtitle: withBar,
                            titleLine: titleLine, hairline: hairline, scale: scale)
        let block = row.subtitle ?? .zero
        self.subtitle = CGRect(x: block.minX, y: block.minY, width: block.width, height: max(0, block.height - room))
        track = CGRect(x: block.minX, y: block.maxY - M.barHeight, width: block.width, height: M.barHeight)
        let part = min(1, max(0, fraction))
        let pixels = max(1, scale)
        fill = CGRect(x: track.minX, y: track.minY, width: (track.width * part * pixels).rounded() / pixels, height: M.barHeight)
    }
}
