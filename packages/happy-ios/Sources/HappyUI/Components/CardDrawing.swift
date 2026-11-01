#if canImport(UIKit)
import HappyIcons
import HappyLayout
import UIKit
import UltraView

/// A face and size a card list draws text in, already at the screen's
/// text size: made on the main thread or off it, turned into a font where
/// it is measured and drawn.
struct CardFont: Equatable, Hashable, Sendable {
    var weight: Fonts.Weight
    var size: CGFloat
    var mono = false

    /// `size` at the person's text size, where the screen follows it.
    init(_ weight: Fonts.Weight, _ size: CGFloat, scale: CGFloat = 1, mono: Bool = false) {
        self.weight = weight
        self.size = (size * scale * 2).rounded() / 2
        self.mono = mono
    }

    var font: UIFont { mono ? Fonts.mono(bold: weight == .bold || weight == .semiBold, size: size) : Fonts.ui(weight, size: size) }
}

/// Text measured the way `CardDrawing` draws it: TextKit 1, no line
/// padding, the used rect up to the screen's next pixel. Safe off the
/// main thread.
enum CardText {
    nonisolated static func attributes(_ font: CardFont, color: UIColor, kern: CGFloat = 0, strike: Bool = false, wraps: Bool) -> [NSAttributedString.Key: Any] {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = wraps ? .byWordWrapping : .byTruncatingTail
        var attributes: [NSAttributedString.Key: Any] = [.font: font.font, .foregroundColor: color, .paragraphStyle: paragraph]
        if kern != 0 { attributes[.kern] = kern }
        if strike {
            attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
            attributes[.strikethroughColor] = color
        }
        return attributes
    }

    nonisolated static func measure(_ text: String, font: CardFont, width: CGFloat, maxLines: Int, scale: CGFloat, kern: CGFloat = 0) -> CGSize {
        guard !text.isEmpty else { return .zero }
        let storage = NSTextStorage(string: text, attributes: attributes(font, color: .black, kern: kern, wraps: true))
        let manager = NSLayoutManager()
        let container = NSTextContainer(size: CGSize(width: max(0, width), height: .greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        container.maximumNumberOfLines = maxLines
        if maxLines > 0 { container.lineBreakMode = .byTruncatingTail }
        manager.addTextContainer(container)
        storage.addLayoutManager(manager)
        manager.ensureLayout(for: container)
        let used = manager.usedRect(for: container)
        let pixels = max(scale, 1)
        func ceiled(_ value: CGFloat) -> CGFloat { (value * pixels).rounded(.up) / pixels }
        return CGSize(width: min(ceiled(used.width), max(0, width)), height: ceiled(used.height))
    }

    nonisolated static func measurable(_ text: String, font: CardFont, maxLines: Int, scale: CGFloat, kern: CGFloat = 0) -> Measurable {
        Measurable { measure(text, font: font, width: $0, maxLines: maxLines, scale: scale, kern: kern) }
    }

    /// One line's height in `font`, for a row that must be as tall
    /// whatever its text.
    nonisolated static func line(_ font: CardFont, scale: CGFloat) -> CGFloat {
        measure("Ag", font: font, width: 10_000, maxLines: 1, scale: scale).height
    }
}

/// What one slot of a card list draws as a bitmap, on UltraView's display
/// queue: text, glyphs, tiles and hairlines, at frames a pure layout chose.
/// The card's fill and a finger's highlight are the row view's, under it;
/// pictures, checkboxes and charts are live views over it.
struct CardDrawing: Drawing, Equatable {
    enum Mark: Equatable, Sendable {
        case text(String, CardFont, ColorToken, CGRect, wraps: Bool, strike: Bool, kern: CGFloat)
        case icon(Icon, CGFloat, ColorToken, CGRect)
        /// A rounded square, filled.
        case tile(CGRect, radius: CGFloat, ColorToken)
        case fill(CGRect, ColorToken)
        /// A ring `width` wide.
        case ring(CGRect, width: CGFloat, ColorToken)
    }

    var marks: [Mark] = []
    var dark = false
    var displayScale: CGFloat = 2

    mutating func text(_ value: String, _ font: CardFont, _ color: ColorToken, _ frame: CGRect, wraps: Bool = false, strike: Bool = false, kern: CGFloat = 0) {
        guard !value.isEmpty, frame.width > 0, frame.height > 0 else { return }
        marks.append(.text(value, font, color, frame, wraps: wraps, strike: strike, kern: kern))
    }

    mutating func icon(_ icon: Icon, size: CGFloat, _ color: ColorToken, in frame: CGRect) {
        marks.append(.icon(icon, size, color, frame))
    }

    mutating func rule(_ frame: CGRect?, _ color: ColorToken = Palette.groupedSeparator) {
        if let frame { marks.append(.fill(frame, color)) }
    }

    func draw(in context: CGContext, bounds: CGRect) {
        #if DEBUG || HAPPY_FIXTURES
        dispatchPrecondition(condition: .notOnQueue(.main))
        #endif
        UIGraphicsPushContext(context)
        defer { UIGraphicsPopContext() }
        for mark in marks {
            switch mark {
            case .text(let value, let font, let color, let frame, let wraps, let strike, let kern):
                let attributes = CardText.attributes(font, color: resolved(color), kern: kern, strike: strike, wraps: wraps)
                NSAttributedString(string: value, attributes: attributes).draw(with: frame, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], context: nil)
            case .icon(let icon, let size, let color, let frame):
                guard let glyph = IconCatalog.glyph(for: icon) else { continue }
                let layout = glyph.layout(size: size, scale: displayScale)
                let box = layout.frame(centeredIn: frame, scale: displayScale)
                context.saveGState()
                context.translateBy(x: box.minX + layout.glyphOrigin.x, y: box.minY + layout.glyphOrigin.y)
                context.scaleBy(x: layout.glyphScale, y: layout.glyphScale)
                context.setFillColor(resolved(color).cgColor)
                context.addPath(glyph.path.cgPath)
                context.fillPath()
                context.restoreGState()
            case .tile(let frame, let radius, let color):
                context.setFillColor(resolved(color).cgColor)
                context.addPath(UIBezierPath(roundedRect: frame, cornerRadius: radius).cgPath)
                context.fillPath()
            case .fill(let frame, let color):
                context.setFillColor(resolved(color).cgColor)
                context.fill(frame)
            case .ring(let frame, let width, let color):
                context.setStrokeColor(resolved(color).cgColor)
                context.setLineWidth(width)
                context.strokeEllipse(in: frame.insetBy(dx: width / 2, dy: width / 2))
            }
        }
    }

    nonisolated func resolved(_ token: ColorToken) -> UIColor {
        UIColor(dark ? token.dark : token.light)
    }
}
#endif
