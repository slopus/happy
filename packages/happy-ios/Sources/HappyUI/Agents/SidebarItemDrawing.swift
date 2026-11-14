#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit
import UltraView

/// What one row of home's list draws as a bitmap, on UltraView's display
/// queue: the hairline under it, its title, a heading's title, the
/// trailing question or clock and a fold's chevron. Everything else a row
/// shows stays a view of `SidebarItemView`: the card's fill and a finger's
/// highlight under the bitmap, and the mark and the working signal over it.
///
/// It draws what `RowView` lays out with labels, in the same faces,
/// colours and frames, as those labels would draw it: one line centred on
/// its box, a title too long for it fading out at its end
/// (`SidebarTypography.draw`), anything else cut at the tail. It holds only values, and decides nothing
/// about where anything goes.
struct SidebarItemDrawing: Drawing, Equatable {
    var row: Row
    /// The row's frames, from its slot's top-left (`SidebarLayout.local`).
    var frame: SidebarLayout.Frame
    var selected: Bool
    var dark: Bool
    /// The screen's pixels per point, for whole-pixel text boxes.
    var displayScale: CGFloat

    /// Equal when they draw the same: the row's fields the bitmap and its
    /// sheen read, not the rest it carries (when it last did something,
    /// its subtasks, where it opens). A working row's activity moves every
    /// minute; drawn again for that, it would be measured and drawn anew
    /// for nothing.
    static func == (a: Self, b: Self) -> Bool {
        a.frame == b.frame && a.selected == b.selected && a.dark == b.dark && a.displayScale == b.displayScale
            && a.row.kind == b.row.kind && a.row.label == b.row.label && a.row.unread == b.row.unread
            && a.row.isNew == b.row.isNew && a.row.status == b.row.status && a.row.collapsed == b.row.collapsed
            && a.row.hasHiddenSessions == b.row.hasHiddenSessions && a.row.lineChanges == b.row.lineChanges
            && a.row.targetKind == b.row.targetKind && a.row.count == b.row.count && a.row.detail == b.row.detail
    }

    #if DEBUG
    /// Tests stand in for a slow display queue (a hot phone, many rows) with
    /// this: each drawing takes up to this many seconds longer.
    nonisolated(unsafe) static var testDrawDelay: Double = 0
    #endif

    func draw(in context: CGContext, bounds: CGRect) {
        #if DEBUG || HAPPY_FIXTURES
        dispatchPrecondition(condition: .notOnQueue(.main))
        #endif
        #if DEBUG
        if Self.testDrawDelay > 0 { Thread.sleep(forTimeInterval: .random(in: 0...Self.testDrawDelay)) }
        #endif
        UIGraphicsPushContext(context)
        defer { UIGraphicsPopContext() }
        // The tokens' dynamic colours resolve for this row's appearance.
        UITraitCollection(userInterfaceStyle: dark ? .dark : .light).performAsCurrent { drawContent() }
    }

    private func drawContent() {
        if let line = frame.cell?.separator {
            UIColor(Palette.groupedSeparator).setFill()
            UIRectFill(line)
        }
        switch row.kind {
        case .separator:
            return
        case .section:
            // iOS's section header: small capitals in the quiet grey.
            let title = NSAttributedString(string: row.label.uppercased(), attributes: [
                .font: RowView.groupedHeadingFont,
                .kern: GroupedSidebarMetrics.headingSize * RowView.groupedHeadingTracking,
                .foregroundColor: UIColor(Palette.settingsSecondary),
            ])
            Self.drawLine(title, in: frame.label, scale: displayScale)
            if row.collapsed != nil, let glyph = frame.chevronGlyph {
                Self.drawGlyph(chevron(GroupedSidebarMetrics.headingGlyph), color: UIColor(Palette.settingsSecondary), in: glyph)
            }
            return
        default:
            break
        }
        SidebarTypography.draw(title, in: frame.label, scale: displayScale)
        if let detail = row.detail, let box = frame.detail {
            let line = NSAttributedString(string: detail, attributes: [
                .font: Fonts.ui(.regular, size: GroupedSidebarMetrics.detailSize), .foregroundColor: UIColor(Palette.settingsSecondary),
            ])
            Self.drawLine(line, in: box, scale: displayScale)
        }
        if let box = frame.lineChanges {
            if let count = row.count { SidebarLineChanges.draw(count: count, in: box, scale: displayScale) }
            else { SidebarLineChanges.draw(row.lineChanges, in: box, scale: displayScale) }
        }
        if (row.kind == .space || row.kind == .session) && row.collapsed != nil, let glyph = frame.chevronGlyph {
            Self.drawGlyph(chevron(Metrics.chevronGlyph), color: UIColor(Palette.rowText), in: glyph)
        }
        drawTrailing()
    }

    /// A row's title in its font and ink (a dynamic colour, resolved where
    /// it is drawn).
    var title: NSAttributedString { title(UIColor(titleInk)) }

    private var titleInk: ColorToken {
        selected || row.unread || row.isNew ? Palette.rowTextActive : Palette.rowText
    }

    private func title(_ ink: UIColor) -> NSAttributedString {
        let font = Fonts.ui(row.unread || row.isNew ? .bold : selected ? .semiBold : .medium, size: Metrics.labelSize)
        return NSAttributedString(string: row.label, attributes: [.font: font, .foregroundColor: ink])
    }

    // MARK: Shimmer

    /// A bot, task or subtask whose work runs sweeps its title
    /// (`RowView.shimmers`): the bitmap draws it as any, and a band over it
    /// (`ShimmerBand`) wipes a paler copy through the letters.
    var shimmers: Bool { RowView.shimmers(row) }

    /// How far the title's words run from its frame's left edge: the band
    /// crosses the words, not the column they sit in.
    func titleAdvance() -> CGFloat {
        let measured = title.boundingRect(with: CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin], context: nil)
        return min(frame.label.width, measured.width.rounded(.up))
    }

    /// The title again in the sheen band's colour, where it stands in its
    /// own frame: the copy the band masks. The ground is the card the row
    /// sits on, lit as the open screen lights it.
    func drawShimmerCopy(in context: CGContext) {
        UIGraphicsPushContext(context)
        defer { UIGraphicsPopContext() }
        let ground = selected ? Palette.groupedCellHighlight : Palette.groupedCard
        let band = Shimmer.highlight(.sheen, ink: titleInk, ground: ground)
        let ink = UIColor(dark ? band.dark : band.light)
        UITraitCollection(userInterfaceStyle: dark ? .dark : .light).performAsCurrent {
            SidebarTypography.draw(title(ink), in: CGRect(origin: .zero, size: frame.label.size), scale: displayScale)
        }
    }

    /// `Glyphs.image` at this screen's pixels.
    private func glyph(_ name: String, size: CGFloat) -> UIImage {
        UIImage.icon(Glyphs.icon(name), size: size, scale: displayScale)
    }

    private func chevron(_ size: CGFloat) -> UIImage {
        glyph(row.collapsed == true || row.hasHiddenSessions ? "chevron-right" : "chevron-down", size: size)
    }

    /// The question, the clock or a new row's dot in the trailing square.
    private func drawTrailing() {
        guard let trailing = frame.trailing else { return }
        switch row.status {
        case .awaitingInput:
            Self.drawGlyph(glyph("question", size: Metrics.questionGlyph), color: UIColor(Palette.rowText), in: trailing)
        case .waiting:
            Self.drawGlyph(glyph("clock", size: Metrics.clockGlyph), color: UIColor(Palette.rowText), in: trailing)
        case .working, .none:
            guard row.isNew else { return }
            UIColor(Palette.rowNewDot).setFill()
            let dot = CGRect(x: trailing.midX - Metrics.newDot / 2, y: trailing.midY - Metrics.newDot / 2, width: Metrics.newDot, height: Metrics.newDot)
            UIBezierPath(ovalIn: dot).fill()
        }
    }

    // MARK: As UIKit draws them

    /// One line as a label draws it: cut at the tail, and centred on its
    /// box's height on the label's own text height.
    static func drawLine(_ text: NSAttributedString, in box: CGRect, scale: CGFloat) {
        guard box.width > 0, text.length > 0 else { return }
        let line = NSMutableAttributedString(attributedString: text)
        line.addParagraphLineBreak(.byTruncatingTail)
        let measured = line.boundingRect(with: CGSize(width: box.width, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin], context: nil)
        // A label's text is whole points tall, centred in its own box on
        // the pixel above, wherever the box is.
        let height = min(box.height, measured.height.rounded(.up))
        let y = box.minY + pixelFloor((box.height - height) / 2, scale)
        line.draw(with: CGRect(x: box.minX, y: y, width: box.width, height: height), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], context: nil)
    }

    /// A template image tinted `color`, in the middle of `box` at its own
    /// size, as an image view centres it.
    static func drawGlyph(_ image: UIImage, color: UIColor, in box: CGRect) {
        let size = image.size
        let rect = CGRect(x: box.midX - size.width / 2, y: box.midY - size.height / 2, width: size.width, height: size.height)
        image.withTintColor(color, renderingMode: .alwaysOriginal).draw(in: rect)
    }

    private static func pixelFloor(_ value: CGFloat, _ scale: CGFloat) -> CGFloat {
        // A hair over, so a pixel's own edge stays that pixel.
        scale > 0 ? (value * scale + 0.001).rounded(.down) / scale : (value + 0.001).rounded(.down)
    }
}

private extension NSMutableAttributedString {
    /// Every paragraph breaks its lines `mode`, keeping its other settings.
    func addParagraphLineBreak(_ mode: NSLineBreakMode) {
        let whole = NSRange(location: 0, length: length)
        var runs: [(NSRange, NSParagraphStyle?)] = []
        enumerateAttribute(.paragraphStyle, in: whole) { value, range, _ in runs.append((range, value as? NSParagraphStyle)) }
        for (range, style) in runs {
            let paragraph = (style?.mutableCopy() as? NSMutableParagraphStyle) ?? NSMutableParagraphStyle()
            paragraph.lineBreakMode = mode
            addAttribute(.paragraphStyle, value: paragraph, range: range)
        }
    }
}
#endif
