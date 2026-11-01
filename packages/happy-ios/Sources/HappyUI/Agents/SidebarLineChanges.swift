#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyIcons
import UIKit
import CoreText

/// Counts' flat digit height equals the title's x-height; both share a baseline.
enum SidebarLineChanges {
    nonisolated static var font: UIFont {
        let reference = UIFont.monospacedSystemFont(ofSize: Metrics.labelSize, weight: .medium)
        let title = Fonts.ui(.medium, size: Metrics.labelSize)
        return reference.withSize(reference.pointSize * title.xHeight / reference.capHeight)
    }
    nonisolated static func text(_ changes: GitLineChanges?) -> NSAttributedString {
        let result = NSMutableAttributedString(string: "")
        guard let changes else { return result }
        let font = Self.font
        func append(_ text: String, color: ColorToken) {
            if result.length > 0 {
                let space = (" " as NSString).size(withAttributes: [.font: font]).width
                result.append(NSAttributedString(string: " ", attributes: [.font: font, .kern: 6 - space]))
            }
            result.append(NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: UIColor(color)]))
        }
        if changes.insertions > 0 { append("+" + GitLineChanges.compact(changes.insertions), color: Palette.settingsSecondary) }
        if changes.deletions > 0 { append("−" + GitLineChanges.compact(changes.deletions), color: Palette.settingsSecondary) }
        return result
    }

    nonisolated static func width(_ changes: GitLineChanges?) -> CGFloat {
        inkBounds(text(changes)).width.rounded(.up)
    }

    /// Glyph-path bounds omit the final digit's side bearing, so counts line
    /// up with the dots themselves rather than an invisible text-cell edge.
    nonisolated private static func inkBounds(_ text: NSAttributedString) -> CGRect {
        CTLineGetBoundsWithOptions(CTLineCreateWithAttributedString(text), .useGlyphPathBounds)
    }

    nonisolated static func draw(_ changes: GitLineChanges?, in box: CGRect, scale: CGFloat = 3) {
        guard box.width > 0, let context = UIGraphicsGetCurrentContext() else { return }
        let text = text(changes)
        let ink = inkBounds(text)
        context.saveGState()
        context.clip(to: box)
        SidebarTypography.draw(text, in: box, scale: scale, originX: box.maxX - ink.maxX)
        context.restoreGState()
    }

    nonisolated static func accessibility(_ changes: GitLineChanges?) -> String? {
        guard let changes else { return nil }
        return [changes.approximate ? "≈" : nil, changes.insertions > 0 ? "+\(changes.insertions)" : nil, changes.deletions > 0 ? "−\(changes.deletions)" : nil]
            .compactMap { $0 }.joined(separator: " ")
    }
}

final class SidebarLineChangesView: UIView {
    var changes: GitLineChanges? { didSet { if changes != oldValue { setNeedsDisplay() } } }
    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        contentMode = .redraw
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: Self, _) in view.setNeedsDisplay() }
    }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }
    override func draw(_ rect: CGRect) { SidebarLineChanges.draw(changes, in: bounds, scale: traitCollection.displayScale) }
}

/// A font-derived baseline, independent of the actual title or count string.
enum SidebarTypography {
    /// Visible status ink inside the existing centered 27pt image lane.
    nonisolated static func trailingInk(_ row: Row, scale: CGFloat) -> CGRect? {
        guard row.hasTrailingMark else { return nil }
        let size: CGFloat
        let icon: Icon
        switch row.status {
        case .awaitingInput: size = Metrics.questionGlyph; icon = .ionicons("help-circle")
        case .waiting: size = Metrics.clockGlyph; icon = .ionicons("time-outline")
        default:
            return CGRect(x: (Metrics.trailing - Metrics.newDot) / 2, y: (Metrics.trailing - Metrics.newDot) / 2, width: Metrics.newDot, height: Metrics.newDot)
        }
        guard let glyph = IconCatalog.glyph(for: icon) else { return nil }
        let layout = glyph.layout(size: size, scale: scale)
        return glyph.path.cgPath.boundingBoxOfPath
            .applying(CGAffineTransform(scaleX: layout.glyphScale, y: layout.glyphScale))
            .offsetBy(dx: (Metrics.trailing - layout.size.width) / 2, dy: (Metrics.trailing - layout.size.height) / 2)
    }

    nonisolated static func baseline(in box: CGRect, scale: CGFloat) -> CGFloat {
        let xHeight = Fonts.ui(.medium, size: Metrics.labelSize).xHeight
        return ((box.midY + xHeight / 2) * max(1, scale)).rounded() / max(1, scale)
    }

    nonisolated static func draw(_ text: NSAttributedString, in box: CGRect, scale: CGFloat, originX: CGFloat? = nil) {
        guard box.width > 0, text.length > 0, let context = UIGraphicsGetCurrentContext() else { return }
        var line = CTLineCreateWithAttributedString(text)
        if originX == nil, CTLineGetTypographicBounds(line, nil, nil, nil) > box.width {
            let ellipsis = CTLineCreateWithAttributedString(NSAttributedString(string: "…", attributes: text.attributes(at: 0, effectiveRange: nil)))
            line = CTLineCreateTruncatedLine(line, box.width, .end, ellipsis) ?? ellipsis
        }
        context.saveGState()
        context.clip(to: box)
        context.textMatrix = .identity
        context.translateBy(x: originX ?? box.minX, y: baseline(in: box, scale: scale))
        context.scaleBy(x: 1, y: -1)
        context.textPosition = .zero
        CTLineDraw(line, context)
        context.restoreGState()
    }
}

final class SidebarTitleLabel: UILabel {
    override func drawText(in rect: CGRect) {
        guard let attributedText, attributedText.length > 0 else { return }
        guard (attributedText.attribute(.font, at: 0, effectiveRange: nil) as? UIFont)?.pointSize == Metrics.labelSize else {
            super.drawText(in: rect)
            return
        }
        let text = NSMutableAttributedString(attributedString: attributedText)
        text.addAttribute(.foregroundColor, value: textColor ?? UIColor.label, range: NSRange(location: 0, length: text.length))
        SidebarTypography.draw(text, in: rect, scale: traitCollection.displayScale)
    }
}
#endif