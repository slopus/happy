import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// C-311 SidebarProposal (`SidebarProposal.tsx`, `sidebar-proposal.css`): a
/// sidebar Prioritizing proposed, in its chat, at the column's left. The
/// card holds the real sidebar rows at their full height, never scrolled:
///
///     card    column width, max 360 · 1pt hairline · 12 radius · 12 padding · gap 8
///     header  20 tall: "Proposed sidebar", then the version, muted
///     frame   the rows on the sidebar's ground, 8 radius
///     footer  28 tall whatever it holds: the two answers at the right, a
///             notice left of them, or one muted line once answered, so
///             answering moves nothing
public struct StemCellSidebarProposalLayout: Equatable, Sendable {
    public enum Metrics {
        public static let maxWidth: CGFloat = 360
        public static let padding: CGFloat = 12
        public static let radius: CGFloat = 12
        public static let border: CGFloat = 1
        public static let gap: CGFloat = 8
        /// The header's line: 13pt, the title 600 and the version 400.
        public static let headerHeight: CGFloat = 20
        public static let headerSize: CGFloat = 13
        public static let versionGap: CGFloat = 6
        public static let frameRadius: CGFloat = 8
        public static let footerHeight: CGFloat = 28
        /// `Button size="small"`: 28 tall, 10 either side of a 12/16 label
        /// inside a 1pt ring, a pill.
        public static let buttonHeight: CGFloat = 28
        public static let buttonPadding: CGFloat = 10
        public static let buttonSize: CGFloat = 12
        public static let buttonGap: CGFloat = 8
        /// The answered line and the notice: 12/16.
        public static let noteSize: CGFloat = 12
        public static let noteHeight: CGFloat = 16
        /// A declined proposal's rows.
        public static let declinedAlpha: CGFloat = 0.6
        /// Both answers while one is on its way.
        public static let disabledAlpha: CGFloat = 0.48
    }

    public enum Footer: Equatable, Sendable {
        /// Open: the two answers' label widths, and whether a notice stands
        /// left of them.
        case answers(keep: CGFloat, use: CGFloat, notice: Bool)
        /// Answered: one line.
        case status
    }

    public struct Input: Equatable, Sendable {
        /// The rows shown, as the sidebar lays them out.
        public var rows: [StemCellsSidebarLayout.Row]
        public var titleWidth: CGFloat
        public var footer: Footer

        public init(rows: [StemCellsSidebarLayout.Row], titleWidth: CGFloat, footer: Footer) {
            self.rows = rows
            self.titleWidth = titleWidth
            self.footer = footer
        }
    }

    public var size: CGSize
    public var title: CGRect
    /// The rest of the header's line, after the title.
    public var version: CGRect
    /// The rows' ground; the sidebar inside it lays itself out at its width.
    public var frame: CGRect
    public var footer: CGRect
    public var keep: CGRect?
    public var use: CGRect?
    public var notice: CGRect?
    public var status: CGRect?

    /// `width` is the column the card stands in.
    public init(width: CGFloat, input: Input) {
        typealias M = Metrics
        let cardWidth = max(0, min(width, M.maxWidth))
        let inner = max(0, cardWidth - 2 * M.padding)
        let left = M.padding
        var y = M.padding
        let titleWidth = min(input.titleWidth.rounded(.up), inner)
        title = CGRect(x: left, y: y, width: titleWidth, height: M.headerHeight)
        let versionX = min(left + inner, title.maxX + M.versionGap)
        version = CGRect(x: versionX, y: y, width: max(0, left + inner - versionX), height: M.headerHeight)
        y += M.headerHeight + M.gap
        let rows = StemCellsSidebarLayout.layout(input.rows, width: inner)
        frame = CGRect(x: left, y: y, width: inner, height: rows.contentHeight)
        y += rows.contentHeight + M.gap
        footer = CGRect(x: left, y: y, width: inner, height: M.footerHeight)
        let noteY = footer.midY - M.noteHeight / 2
        switch input.footer {
        case .answers(let keepText, let useText, let hasNotice):
            let buttonY = footer.midY - M.buttonHeight / 2
            let useWidth = Self.buttonWidth(useText)
            let keepWidth = Self.buttonWidth(keepText)
            let use = CGRect(x: footer.maxX - useWidth, y: buttonY, width: useWidth, height: M.buttonHeight)
            let keep = CGRect(x: use.minX - M.buttonGap - keepWidth, y: buttonY, width: keepWidth, height: M.buttonHeight)
            self.use = use
            self.keep = keep
            status = nil
            notice = hasNotice ? CGRect(x: left, y: noteY, width: max(0, keep.minX - M.buttonGap - left), height: M.noteHeight) : nil
        case .status:
            use = nil
            keep = nil
            notice = nil
            // The footer ends its content at the right (`justify-content: flex-end`).
            status = CGRect(x: left, y: noteY, width: inner, height: M.noteHeight)
        }
        y += M.footerHeight + M.padding
        size = CGSize(width: cardWidth, height: y)
    }

    /// A small button around a label `text` wide: its padding and ring.
    public static func buttonWidth(_ text: CGFloat) -> CGFloat {
        text.rounded(.up) + 2 * Metrics.buttonPadding + 2 * Metrics.border
    }
}
