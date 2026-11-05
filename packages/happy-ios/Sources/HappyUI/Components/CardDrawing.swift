#if canImport(UIKit)
import HappyCore
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

/// One TextKit 1 layout of words and the tappable words after them, in
/// their own colour: how a `.paragraph` is measured (`FeedSummaryText`)
/// and drawn, so the two agree to the glyph. Safe off the main thread.
struct CardTextStack {
    let storage: NSTextStorage
    let manager = NSLayoutManager()
    let container: NSTextContainer
    let toggleRange: NSRange?

    nonisolated init(_ text: String, _ toggle: String?, font: CardFont, width: CGFloat, lines: Int, color: UIColor = .black, toggleColor: UIColor = .black) {
        let string = NSMutableAttributedString(string: text, attributes: CardText.attributes(font, color: color, wraps: true))
        if let toggle {
            toggleRange = NSRange(location: string.length, length: (toggle as NSString).length)
            string.append(NSAttributedString(string: toggle, attributes: CardText.attributes(font, color: toggleColor, wraps: true)))
        } else {
            toggleRange = nil
        }
        storage = NSTextStorage(attributedString: string)
        container = NSTextContainer(size: CGSize(width: max(0, width), height: .greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        container.maximumNumberOfLines = lines
        container.lineBreakMode = .byWordWrapping
        manager.addTextContainer(container)
        storage.addLayoutManager(manager)
        manager.ensureLayout(for: container)
    }

    /// Where the laid lines' characters end.
    nonisolated var laidEnd: Int {
        NSMaxRange(manager.characterRange(forGlyphRange: manager.glyphRange(for: container), actualGlyphRange: nil))
    }

    /// Some of the text, besides blank space, is past the last line.
    nonisolated var overflows: Bool {
        let end = laidEnd
        guard end < storage.length else { return false }
        return !(storage.string as NSString).substring(from: end).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Where the last laid line's characters start.
    nonisolated var lastLineStart: Int {
        var start = 0
        manager.enumerateLineFragments(forGlyphRange: manager.glyphRange(for: container)) { _, _, _, glyphs, _ in
            start = manager.characterIndexForGlyph(at: glyphs.location)
        }
        return start
    }

    /// The words' used size up to the screen's next pixel, and where the
    /// toggle's words are, from the origin.
    nonisolated func measured(scale: CGFloat) -> (size: CGSize, toggle: CGRect?) {
        let used = manager.usedRect(for: container)
        let pixels = max(scale, 1)
        func ceiled(_ value: CGFloat) -> CGFloat { (value * pixels).rounded(.up) / pixels }
        let toggle = toggleRange.map { range in
            manager.boundingRect(forGlyphRange: manager.glyphRange(forCharacterRange: range, actualCharacterRange: nil), in: container)
        }
        return (CGSize(width: min(ceiled(used.width), container.size.width), height: ceiled(used.height)), toggle)
    }
}

/// What one slot of a card list draws as a bitmap, on UltraView's display
/// queue: text, glyphs, tiles and hairlines, at frames a pure layout chose.
/// The card's fill and a finger's highlight are the row view's, under it;
/// pictures, checkboxes and charts are live views over it.
struct CardDrawing: Drawing, Equatable {
    enum Mark: Equatable, Sendable {
        case text(String, CardFont, ColorToken, CGRect, wraps: Bool, strike: Bool, kern: CGFloat)
        /// Wrapped words, then words of another colour after them (a
        /// post's Show more), laid out as `CardTextStack` measured them.
        case paragraph(String, CardFont, ColorToken, toggle: String?, ColorToken, CGRect)
        case icon(Icon, CGFloat, ColorToken, CGRect)
        /// A rounded square, filled.
        case tile(CGRect, radius: CGFloat, ColorToken)
        case fill(CGRect, ColorToken)
        /// A ring `width` wide.
        case ring(CGRect, width: CGFloat, ColorToken)
        /// Lines over time on faint guides (a System Monitor's history).
        case chart([ChartLine], CGRect)
        /// One bar per value, 0 to 100, each coloured by its level.
        case bars([Double?], CGRect, gap: CGFloat)
        /// A rounded track filled to `percent`, coloured by its level.
        case meter(Double?, CGRect)
    }

    /// One line of a chart: values from 0 to 1, oldest first, nil where
    /// nothing was measured (the line breaks there).
    struct ChartLine: Equatable, Sendable {
        var values: [Double?]
        var color: ColorToken
        var fills = true
    }

    /// The desktop's level colours: calm, warm, hot; grey unmeasured.
    nonisolated static func level(_ percent: Double?) -> ColorToken {
        switch MonitorLevel.of(percent) {
        case .calm: Palette.monitorCalm
        case .warm: Palette.monitorWarm
        case .hot: Palette.monitorHot
        case .unavailable: Palette.settingsSecondary
        }
    }

    var marks: [Mark] = []
    var dark = false
    var displayScale: CGFloat = 2

    mutating func text(_ value: String, _ font: CardFont, _ color: ColorToken, _ frame: CGRect, wraps: Bool = false, strike: Bool = false, kern: CGFloat = 0) {
        guard !value.isEmpty, frame.width > 0, frame.height > 0 else { return }
        marks.append(.text(value, font, color, frame, wraps: wraps, strike: strike, kern: kern))
    }

    mutating func paragraph(_ value: String, _ font: CardFont, _ color: ColorToken, toggle: String?, _ toggleColor: ColorToken, _ frame: CGRect) {
        guard !value.isEmpty, frame.width > 0, frame.height > 0 else { return }
        marks.append(.paragraph(value, font, color, toggle: toggle, toggleColor, frame))
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
            case .paragraph(let value, let font, let color, let toggle, let toggleColor, let frame):
                let stack = CardTextStack(value, toggle, font: font, width: frame.width, lines: 0, color: resolved(color), toggleColor: resolved(toggleColor))
                stack.manager.drawGlyphs(forGlyphRange: stack.manager.glyphRange(for: stack.container), at: frame.origin)
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
            case .chart(let lines, let frame):
                drawChart(lines, in: frame, context: context)
            case .bars(let values, let frame, let gap):
                guard !values.isEmpty else { continue }
                let width = max(1, (frame.width - gap * CGFloat(values.count - 1)) / CGFloat(values.count))
                let radius = min(2, width / 2)
                for (index, value) in values.enumerated() {
                    let x = frame.minX + CGFloat(index) * (width + gap)
                    let track = CGRect(x: x, y: frame.minY, width: width, height: frame.height)
                    context.setFillColor(resolved(Palette.monitorTrack).cgColor)
                    context.addPath(UIBezierPath(roundedRect: track, cornerRadius: radius).cgPath)
                    context.fillPath()
                    guard let value, value > 0 else { continue }
                    let height = max(radius * 2, frame.height * min(1, value / 100))
                    context.setFillColor(resolved(Self.level(value)).cgColor)
                    context.addPath(UIBezierPath(roundedRect: CGRect(x: x, y: frame.maxY - height, width: width, height: height), cornerRadius: radius).cgPath)
                    context.fillPath()
                }
            case .meter(let percent, let frame):
                let radius = frame.height / 2
                context.setFillColor(resolved(Palette.monitorTrack).cgColor)
                context.addPath(UIBezierPath(roundedRect: frame, cornerRadius: radius).cgPath)
                context.fillPath()
                guard let percent, percent > 0 else { continue }
                let filled = CGRect(x: frame.minX, y: frame.minY, width: max(frame.height, frame.width * min(1, percent / 100)), height: frame.height)
                context.setFillColor(resolved(Self.level(percent)).cgColor)
                context.addPath(UIBezierPath(roundedRect: filled, cornerRadius: radius).cgPath)
                context.fillPath()
            }
        }
    }

    /// Three faint guides, then each line with the ground under it softly
    /// filled; a line of one value draws nothing.
    private func drawChart(_ lines: [ChartLine], in frame: CGRect, context: CGContext) {
        let hairline = 1 / max(1, displayScale)
        context.setFillColor(resolved(Palette.monitorGrid).cgColor)
        for fraction in [0, 0.5, 1] as [CGFloat] {
            context.fill(CGRect(x: frame.minX, y: (frame.minY + (frame.height - hairline) * fraction).rounded(.down), width: frame.width, height: hairline))
        }
        let stroke: CGFloat = 1.5
        let box = frame.insetBy(dx: 0, dy: stroke / 2)
        for line in lines where line.values.count > 1 {
            let step = box.width / CGFloat(line.values.count - 1)
            var runs: [[CGPoint]] = [[]]
            for (index, value) in line.values.enumerated() {
                guard let value else {
                    if !(runs.last?.isEmpty ?? true) { runs.append([]) }
                    continue
                }
                runs[runs.count - 1].append(CGPoint(x: box.minX + CGFloat(index) * step, y: box.maxY - box.height * CGFloat(min(1, max(0, value)))))
            }
            let color = resolved(line.color)
            for run in runs where run.count > 1 {
                if line.fills {
                    // `addLines(between:)` would begin a path of its own.
                    let area = CGMutablePath()
                    area.move(to: CGPoint(x: run[0].x, y: frame.maxY))
                    for point in run { area.addLine(to: point) }
                    area.addLine(to: CGPoint(x: run[run.count - 1].x, y: frame.maxY))
                    area.closeSubpath()
                    context.setFillColor(color.withAlphaComponent(dark ? 0.22 : 0.14).cgColor)
                    context.addPath(area)
                    context.fillPath()
                }
                let path = CGMutablePath()
                path.addLines(between: run)
                context.setStrokeColor(color.cgColor)
                context.setLineWidth(stroke)
                context.setLineJoin(.round)
                context.setLineCap(.round)
                context.addPath(path)
                context.strokePath()
            }
        }
    }

    nonisolated func resolved(_ token: ColorToken) -> UIColor {
        UIColor(dark ? token.dark : token.light)
    }
}
#endif
