import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The migration screen's two-row picture, in a card, symmetric about its
/// middle. Both rows pass through something: the current connection
/// through the Happy server, which keeps the chats (encrypted); after
/// migration through a relay, which only passes them on, still encrypted.
///
///                    Current connection
///     |12| phone ──→ server ──→ computer |12|
///          Phone  Happy server  Computer
///           Stores your chats, encrypted
///     12
///                     After migration
///     |12| phone ──→ router ──→ computer |12|
///          Phone      Relay     Computer
///          Passes through, still encrypted
///
/// A caption is centred under its icon; phone and computer move in from
/// the edges as far as the wider of their captions needs, the same on both
/// sides, so the middle stays in the middle.
public struct ConnectionDiagramLayout: Equatable, Sendable {
    public enum Metrics {
        public static let padding: CGFloat = 12
        public static let headingGap: CGFloat = 6
        public static let icon: CGFloat = 28
        public static let captionGap: CGFloat = 2
        public static let rowGap: CGFloat = 12
        /// Between an icon and the line that leaves or reaches it.
        public static let lineInset: CGFloat = 8
        /// The badge on the server's lower right, and the card around it.
        public static let badge: CGFloat = 14
        public static let badgeGround: CGFloat = 1
        public static let badgeGroundRadius: CGFloat = 2
        /// An open arrowhead's two strokes, back and out from the tip.
        public static let arrowhead: CGFloat = 4
    }

    public struct Row: Equatable, Sendable {
        public var heading: CGRect
        public var phone: CGRect
        public var middle: CGRect
        public var computer: CGRect
        /// The server's badge, and the patch of card under it; nil on the
        /// relay's row.
        public var badge: CGRect?
        public var badgeGround: CGRect?
        /// Phone, the middle, computer.
        public var captions: [CGRect]
        public var detail: CGRect
        /// The lines, each from its start to the end its arrow points at,
        /// and each arrowhead, its tip in the middle.
        public var lines: [[CGPoint]]
        public var arrowheads: [[CGPoint]]
    }

    /// A row's heading, its middle's caption and what the middle does.
    public struct Words {
        public var heading: Measurable
        public var middle: Measurable
        public var detail: Measurable

        public init(heading: Measurable, middle: Measurable, detail: Measurable) {
            self.heading = heading
            self.middle = middle
            self.detail = detail
        }
    }

    public var size: CGSize
    public var current: Row
    public var after: Row

    public init(width: CGFloat, phone: Measurable, computer: Measurable, current: Words, after: Words) {
        typealias M = Metrics
        let width = max(0, width)
        let track = max(0, width - M.padding * 2)
        let phoneSize = phone.size(fitting: track), computerSize = computer.size(fitting: track)
        let reach = max(M.icon, phoneSize.width, computerSize.width) / 2
        let phoneX = M.padding + reach
        let computerX = width - M.padding - reach
        let middleX = width / 2

        func row(top: CGFloat, words: Words, server: Bool) -> Row {
            let headingSize = words.heading.size(fitting: track)
            let heading = CGRect(x: middleX - headingSize.width / 2, y: top, width: headingSize.width, height: headingSize.height)
            let iconY = heading.maxY + M.headingGap
            let midY = iconY + M.icon / 2
            func box(_ x: CGFloat) -> CGRect { CGRect(x: x - M.icon / 2, y: iconY, width: M.icon, height: M.icon) }
            let middleSize = words.middle.size(fitting: track)
            let captionY = iconY + M.icon + M.captionGap
            let captionHeight = max(phoneSize.height, middleSize.height, computerSize.height)
            func caption(_ size: CGSize, _ x: CGFloat) -> CGRect {
                CGRect(x: x - size.width / 2, y: captionY, width: size.width, height: size.height)
            }
            let detailSize = words.detail.size(fitting: track)
            let phone = box(phoneX), middle = box(middleX), computer = box(computerX)
            let badge = server ? CGRect(x: middle.maxX - M.badge + 3, y: middle.maxY - M.badge + 1, width: M.badge, height: M.badge) : nil
            let lines = [
                [CGPoint(x: phone.maxX + M.lineInset, y: midY), CGPoint(x: middle.minX - M.lineInset, y: midY)],
                [CGPoint(x: middle.maxX + M.lineInset, y: midY), CGPoint(x: computer.minX - M.lineInset, y: midY)],
            ]
            return Row(
                heading: heading,
                phone: phone,
                middle: middle,
                computer: computer,
                badge: badge,
                badgeGround: badge?.insetBy(dx: -M.badgeGround, dy: -M.badgeGround),
                captions: [caption(phoneSize, phoneX), caption(middleSize, middleX), caption(computerSize, computerX)],
                detail: CGRect(x: middleX - detailSize.width / 2, y: captionY + captionHeight, width: detailSize.width, height: detailSize.height),
                lines: lines,
                arrowheads: lines.compactMap(\.last).map { tip in
                    [CGPoint(x: tip.x - M.arrowhead, y: tip.y - M.arrowhead), tip, CGPoint(x: tip.x - M.arrowhead, y: tip.y + M.arrowhead)]
                }
            )
        }
        self.current = row(top: M.padding, words: current, server: true)
        self.after = row(top: self.current.detail.maxY + M.rowGap, words: after, server: false)
        size = CGSize(width: width, height: self.after.detail.maxY + M.padding)
    }
}
