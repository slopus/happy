#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

// MARK: - Text

/// `text`: spans in the typography its role calls for. Strong is a heavier
/// Figtree, emphasis its oblique, code the mono face a point and a half
/// smaller on the code well's tint, a link underlined. Measured and drawn
/// by the same TextKit layout (`ChatTextLayout`).
final class GenUITextElement: GenUIElement {
    private let text: GenUIText
    private let style: ChatTextStyle
    private let font: UIFont
    private let environment: TextEnvironment?
    private let base: [NSAttributedString.Key: Any]
    private let string: NSAttributedString
    private let links: [(range: NSRange, url: String)]
    private let maxLines: Int
    private var layouts: [CGFloat: ChatTextLayout] = [:]

    init(key: String, _ text: GenUIText, place: GenUIPlace, context: GenUIPlanContext) {
        self.text = text
        let (style, color, tabular) = Self.look(text.role, inCard: place.inCard)
        self.style = style
        environment = context.environment
        let ink = text.tone.flatMap { GenUIColors.tints($0) ? $0.text : nil } ?? color
        maxLines = switch text.overflow {
        case .wrap: 0
        case .clamp: 2
        case .truncate: 1
        }
        let font = tabular ? Fonts.tabular(style.font(in: context.environment)) : style.font(in: context.environment)
        self.font = font
        base = style.attributes(
            // The paragraph wraps; the layout's line limit cuts a clamp
            // short. A truncating paragraph would never wrap in TextKit.
            color: UIColor(ink), font: font, alignment: place.columnEnd ?? (text.align == .end) ? .right : .natural, in: context.environment
        )
        let result = NSMutableAttributedString()
        var links: [(NSRange, String)] = []
        let size = context.environment.map { style.scaled($0.scale).size } ?? style.size
        for span in text.spans {
            var attributes = base
            if span.code {
                attributes[.font] = Fonts.mono(bold: span.strong, size: size - 1.5)
                attributes[.backgroundColor] = UIColor(Palette.genuiCode)
            } else if span.strong || span.emphasis {
                let weight: ChatWeight = span.strong ? .semibold : (style.face.figtreeWeight ?? .regular)
                let face: ChatFace = span.emphasis ? .figtreeOblique(weight) : .figtree(weight)
                attributes[.font] = ChatTextStyle(face, size: style.size, lineHeight: style.lineHeight).font(in: context.environment)
            }
            if let link = span.link {
                attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue
                links.append((NSRange(location: result.length, length: (span.text as NSString).length), link))
            }
            result.append(NSAttributedString(string: style.uppercase ? span.text.uppercased() : span.text, attributes: attributes))
        }
        string = result
        self.links = links
        super.init(key: key)
    }

    /// Font, colour and figures per role.
    static func look(_ role: GenUIText.Role, inCard: Bool) -> (ChatTextStyle, ColorToken, Bool) {
        switch role {
        case .title: (ChatTextStyles.genuiCardTitle, Palette.cardTitle, false)
        case .subtitle: (ChatTextStyles.genuiCardSubtitle, Palette.cardDetail, false)
        case .heading: (ChatTextStyles.genuiSection, Palette.cardDetail, false)
        case .prompt: (ChatTextStyles.genuiRowTitle.with(.figtree(.semibold)), Palette.cardTitle, false)
        // Bare on the chat, body text is the chat's own.
        case .body: (inCard ? ChatTextStyles.genuiBody : ChatTextStyles.text, Palette.cardTitle, false)
        case .note, .detail: (ChatTextStyles.genuiCaption, Palette.cardDetail, false)
        case .label: (ChatTextStyles.genuiLabel, Palette.cardDetail, false)
        case .value: (ChatTextStyles.genuiStatValue, Palette.cardTitle, true)
        case .delta: (ChatTextStyles.genuiDelta, Palette.cardDetail, true)
        case .item, .rowhead: (ChatTextStyles.genuiRowTitle, Palette.cardTitle, false)
        case .trailing: (ChatTextStyles.genuiCaption, Palette.genuiTertiary, true)
        case .column: (ChatTextStyles.genuiMicro, Palette.genuiTertiary, false)
        case .cell: (ChatTextStyles.genuiCell, Palette.cardTitle, false)
        case .number: (ChatTextStyles.genuiValue, Palette.cardTitle, true)
        case .ordinal: (ChatTextStyles.genuiValue, Palette.genuiTertiary, true)
        }
    }

    func layout(_ width: CGFloat) -> ChatTextLayout {
        if let layout = layouts[width] { return layout }
        let layout = ChatTextLayout(string, width: width, maxLines: maxLines)
        layouts[width] = layout
        return layout
    }

    override func natural(_ width: CGFloat) -> CGSize {
        let size = layout(width).size
        return CGSize(width: min(width, ceil(size.width)), height: ceil(size.height))
    }

    override func baseline(_ width: CGFloat) -> CGFloat {
        let style = environment.map { style.scaled($0.scale) } ?? style
        guard let line = style.lineHeight else { return ceil(font.ascender) }
        return line - abs(font.descender) - (line - font.lineHeight) / 4
    }

    private lazy var widestWord: CGFloat = {
        if text.overflow == .truncate { return min(48, measure(.greatestFiniteMagnitude).width) }
        return text.plain.split(whereSeparator: \.isWhitespace).map { NSAttributedString(string: String($0), attributes: base).size().width }.max().map(ceil) ?? 0
    }()

    override var minWidth: CGFloat { text.fixed ? measure(.greatestFiniteMagnitude).width : widestWord }
    override var neighbour: GenUIMetrics.Neighbour { .text }
    override var isLeading: Bool { text.role == .ordinal }
    override var fixed: Bool { text.fixed }

    override func place(_ frame: CGRect, below: CGFloat) -> GenUIPlaced {
        GenUIPlaced(key: key, frame: frame, mark: .text(GenUITextMark(layout: layout(frame.width), links: links, plain: text.plain)))
    }
}

private extension ChatFace {
    var figtreeWeight: ChatWeight? {
        if case .figtree(let weight) = self { return weight }
        return nil
    }
}

/// One line of plain text in a style, cut short at its end.
func genuiLine(_ text: String, _ style: ChatTextStyle, _ color: ColorToken, alignment: NSTextAlignment = .natural, in environment: TextEnvironment?, tabular: Bool = false) -> NSAttributedString {
    let font = tabular ? Fonts.tabular(style.font(in: environment)) : style.font(in: environment)
    let attributes = style.attributes(color: UIColor(color), font: font, alignment: alignment, lineBreakMode: .byTruncatingTail, in: environment)
    return NSAttributedString(string: style.uppercase ? text.uppercased() : text, attributes: attributes)
}

/// One line of `style` at the text size.
func genuiLineHeight(_ style: ChatTextStyle, _ environment: TextEnvironment?) -> CGFloat {
    environment.map { style.lineHeightValue(in: $0) } ?? style.lineHeightValue
}

extension ColorToken {
    /// The same colour, more see-through.
    func alpha(_ alpha: Double) -> ColorToken {
        var copy = self
        copy.light.alpha *= alpha
        copy.dark.alpha *= alpha
        return copy
    }
}

/// A one-line label placed in `frame`, measured at its own width.
private func genuiLabel(_ key: String, _ string: NSAttributedString, plain: String, frame: CGRect) -> GenUIPlaced {
    GenUIPlaced(key: key, frame: frame, mark: .text(GenUITextMark(layout: ChatTextLayout(string, width: frame.width, maxLines: 1), links: [], plain: plain)))
}

/// A one-line string's natural width.
private func genuiWidth(_ string: NSAttributedString) -> CGFloat {
    ceil(ChatTextLayout(string, width: .greatestFiniteMagnitude, maxLines: 1).size.width)
}

// MARK: - Glyphs and status

/// `icon`: one glyph, `leading` at a row's or header's size, `inline` at a
/// line of text's. A name with no glyph takes no room.
final class GenUIIconElement: GenUIElement {
    private let icon: GenUIIcon
    private let side: CGFloat
    private let drawn: Bool

    init(key: String, _ icon: GenUIIcon) {
        self.icon = icon
        side = icon.role == .leading ? GenUIMetrics.leadingIcon : GenUIMetrics.inlineIcon
        drawn = GenUIIcons.exists(icon.name)
        super.init(key: key)
    }

    override func natural(_ width: CGFloat) -> CGSize { drawn ? CGSize(width: min(width, side), height: side) : .zero }
    /// Centred on the cap height of the text beside it.
    override func baseline(_ width: CGFloat) -> CGFloat { side / 2 + 4.5 }
    override var minWidth: CGFloat { drawn ? side : 0 }
    override var fills: Bool { false }
    override var neighbour: GenUIMetrics.Neighbour { .text }
    override var isLeading: Bool { true }

    override func place(_ frame: CGRect, below: CGFloat) -> GenUIPlaced {
        let rect = CGRect(x: 0, y: 0, width: frame.width, height: min(frame.height, side))
        return GenUIPlaced(key: key, frame: frame, mark: .glyph(name: icon.name, ink: icon.tone.ink, rect: rect))
    }
}

/// `pill`: a short status label on its tone's soft fill.
final class GenUIPillElement: GenUIElement {
    private let pill: GenUIPill
    private let label: NSAttributedString
    private let labelWidth: CGFloat
    private let height: CGFloat
    private let hasIcon: Bool

    init(key: String, _ pill: GenUIPill, context: GenUIPlanContext) {
        self.pill = pill
        hasIcon = pill.icon.map(GenUIIcons.exists) ?? false
        label = genuiLine(pill.text, ChatTextStyles.genuiBadge, pill.tone.text, in: context.environment)
        labelWidth = min(genuiWidth(label), GenUIMetrics.pillMaxText)
        // A larger text size grows the pill around its words.
        height = max(GenUIMetrics.pillHeight, genuiLineHeight(ChatTextStyles.genuiBadge, context.environment) + 6)
        super.init(key: key)
    }

    private var iconWidth: CGFloat { hasIcon ? GenUIMetrics.pillIcon + GenUIMetrics.pillIconGap : 0 }

    override func natural(_ width: CGFloat) -> CGSize {
        CGSize(width: min(width, GenUIMetrics.pillPaddingH * 2 + iconWidth + labelWidth), height: height)
    }

    override func baseline(_ width: CGFloat) -> CGFloat { height / 2 + 4 }
    override var minWidth: CGFloat { measure(.greatestFiniteMagnitude).width }
    override var fills: Bool { false }
    override var neighbour: GenUIMetrics.Neighbour { .text }

    override func place(_ frame: CGRect, below: CGFloat) -> GenUIPlaced {
        typealias M = GenUIMetrics
        var placed = GenUIPlaced(key: key, frame: frame, mark: .surface(GenUISurface(fill: pill.tone.fill, radius: frame.height / 2)))
        var x = M.pillPaddingH
        if hasIcon, let name = pill.icon {
            let rect = CGRect(x: 0, y: 0, width: M.pillIcon, height: M.pillIcon)
            placed.children.append(GenUIPlaced(key: "\(key).icon", frame: CGRect(x: x, y: (frame.height - M.pillIcon) / 2, width: M.pillIcon, height: M.pillIcon), mark: .glyph(name: name, ink: pill.tone.ink, rect: rect)))
            x += iconWidth
        }
        placed.children.append(genuiLabel("\(key).label", label, plain: pill.text, frame: CGRect(x: x, y: 0, width: max(0, frame.width - x - M.pillPaddingH), height: frame.height)))
        return placed
    }
}

/// `button`: filled, outlined, a plain link or a chip. A destructive
/// action is never the filled one.
final class GenUIButtonElement: GenUIElement {
    private let button: GenUIButton
    private let variant: GenUIButton.Variant
    private let label: NSAttributedString
    private let labelWidth: CGFloat
    private let ink: ColorToken
    private let surface: GenUISurface
    private let hasIcon: Bool
    private let height: CGFloat

    init(key: String, _ button: GenUIButton, context: GenUIPlanContext) {
        self.button = button
        let variant = button.tone == .danger && button.variant == .primary ? .secondary : button.variant
        self.variant = variant
        var surface = GenUISurface(radius: GenUIMetrics.buttonRadius)
        let ink: ColorToken
        switch variant {
        case .primary:
            surface.fill = Palette.primaryButton
            ink = Palette.primaryButtonInk
        case .secondary, .chip:
            surface.fill = button.tone == .danger ? nil : Palette.button
            surface.border = button.tone == .danger ? GenUITone.danger.ink.alpha(0.5) : Palette.divider
            surface.borderWidth = 1
            ink = button.tone == .neutral || button.tone == .muted ? Palette.cardTitle : button.tone.text
        case .plain:
            ink = button.tone == .neutral ? GenUITone.accent.text : button.tone.text
        }
        self.ink = ink
        self.surface = surface
        hasIcon = button.icon.map(GenUIIcons.exists) ?? false
        label = genuiLine(button.label, ChatTextStyles.genuiButton, ink, alignment: .center, in: context.environment)
        labelWidth = genuiWidth(label)
        let line = genuiLineHeight(ChatTextStyles.genuiButton, context.environment)
        height = max(variant == .chip ? GenUIMetrics.chipHeight : GenUIMetrics.buttonHeight, line + 16)
        super.init(key: key)
    }

    private var padding: CGFloat { variant == .chip ? GenUIMetrics.chipPaddingH : GenUIMetrics.buttonPaddingH }
    private var iconWidth: CGFloat { hasIcon ? GenUIMetrics.buttonIcon + GenUIMetrics.buttonIconGap : 0 }

    override func natural(_ width: CGFloat) -> CGSize { CGSize(width: min(width, labelWidth + iconWidth + 2 * padding), height: height) }
    override func baseline(_ width: CGFloat) -> CGFloat { height / 2 + 5 }
    override var minWidth: CGFloat { measure(.greatestFiniteMagnitude).width }
    override var fills: Bool { false }
    override var neighbour: GenUIMetrics.Neighbour { .other }

    override func place(_ frame: CGRect, below: CGFloat) -> GenUIPlaced {
        let mark = GenUIButtonMark(action: button.action, group: button.group, label: button.label, surface: surface)
        var placed = GenUIPlaced(key: key, frame: frame, mark: .button(mark))
        let textWidth = max(0, min(labelWidth, frame.width - 2 * padding - iconWidth))
        let x = (frame.width - textWidth - iconWidth) / 2
        if hasIcon, let name = button.icon {
            let side = GenUIMetrics.buttonIcon
            placed.children.append(GenUIPlaced(
                key: "\(key).icon", frame: CGRect(x: x, y: 0, width: side, height: frame.height),
                mark: .glyph(name: name, ink: ink, rect: CGRect(x: 0, y: (frame.height - side) / 2, width: side, height: side))
            ))
        }
        placed.children.append(genuiLabel("\(key).label", label, plain: button.label, frame: CGRect(x: x + iconWidth, y: 0, width: textWidth, height: frame.height)))
        return placed
    }
}

// MARK: - Drawings

/// `bar`: a progress track filled to its value.
final class GenUIBarElement: GenUIElement {
    private let bar: GenUIBar

    init(key: String, _ bar: GenUIBar) {
        self.bar = bar
        super.init(key: key)
    }

    override func natural(_ width: CGFloat) -> CGSize { CGSize(width: width, height: GenUIMetrics.bar) }
    override var minWidth: CGFloat { 60 }

    override func place(_ frame: CGRect, below: CGFloat) -> GenUIPlaced {
        GenUIPlaced(key: key, frame: frame, mark: .bar(value: bar.value, ink: bar.tone.ink))
    }
}

/// `marker`: a step's status, one diameter for every status. Its frame
/// runs down to the next step when it has a rail.
final class GenUIMarkerElement: GenUIElement {
    private let marker: GenUIMarker

    init(key: String, _ marker: GenUIMarker) {
        self.marker = marker
        super.init(key: key)
    }

    override func natural(_ width: CGFloat) -> CGSize { CGSize(width: GenUIMetrics.marker, height: GenUIMetrics.marker) }
    override func baseline(_ width: CGFloat) -> CGFloat { GenUIMetrics.marker / 2 + 5 }
    override var minWidth: CGFloat { GenUIMetrics.marker }
    override var fills: Bool { false }
    override var isLeading: Bool { true }
    override var hasRail: Bool { marker.rail }

    override func place(_ frame: CGRect, below: CGFloat) -> GenUIPlaced {
        GenUIPlaced(key: key, frame: frame, mark: .marker(marker.status, rail: marker.rail))
    }
}

/// `spark`: a tiny trend line fitted to its box.
final class GenUISparkElement: GenUIElement {
    private let spark: GenUISpark

    init(key: String, _ spark: GenUISpark) {
        self.spark = spark
        super.init(key: key)
    }

    override func natural(_ width: CGFloat) -> CGSize { CGSize(width: width, height: GenUIMetrics.spark) }
    override var minWidth: CGFloat { 60 }

    override func place(_ frame: CGRect, below: CGFloat) -> GenUIPlaced {
        GenUIPlaced(key: key, frame: frame, mark: .spark(spark.values, ink: spark.tone.ink))
    }
}

/// `plot`: a chart whose height follows only its width and its legend.
final class GenUIPlotElement: GenUIElement {
    private let shape: GenUIPlotShape

    init(key: String, _ plot: GenUIPlot, context: GenUIPlanContext) {
        shape = GenUIPlotShape(plot, environment: context.environment, hairline: context.hairline)
        super.init(key: key)
    }

    override func natural(_ width: CGFloat) -> CGSize { CGSize(width: width, height: shape.height(width)) }
    override var minWidth: CGFloat { 200 }

    override func place(_ frame: CGRect, below: CGFloat) -> GenUIPlaced {
        GenUIPlaced(key: key, frame: frame, mark: .plot(shape))
    }
}

/// `image`: a stored file filling a box of its shape, its final size from
/// the start whether or not the file has arrived. `figure` is rounded and
/// height-capped, `tile` square-cornered (its mosaic rounds the whole),
/// `thumb` a small leading square, `cover` the rounded top of a carousel card.
final class GenUIImageElement: GenUIElement {
    /// The shade under an overlay's words, as dark on either theme.
    private static let dim = ColorToken(light: RGBA(red: 0, green: 0, blue: 0, alpha: 0.45), dark: RGBA(red: 0, green: 0, blue: 0, alpha: 0.45))
    let shape: GenUIShape
    private let image: GenUIImage
    private let overlay: NSAttributedString?

    init(key: String, _ image: GenUIImage, context: GenUIPlanContext) {
        self.image = image
        shape = image.shape
        overlay = image.overlay.map {
            let paragraph = NSMutableParagraphStyle()
            paragraph.alignment = .center
            return NSAttributedString(string: $0, attributes: [.font: Fonts.ui(.semiBold, size: 22), .foregroundColor: UIColor.white, .paragraphStyle: paragraph])
        }
        super.init(key: key)
    }

    override func natural(_ width: CGFloat) -> CGSize {
        switch image.role {
        case .thumb: CGSize(width: min(width, GenUIMetrics.thumb), height: GenUIMetrics.thumb)
        case .figure: CGSize(width: width, height: min(GenUIMetrics.figureMaxHeight, (width * GenUIMetrics.ratio(shape.rawValue)).rounded()))
        case .tile, .cover: CGSize(width: width, height: (width * GenUIMetrics.ratio(shape.rawValue)).rounded())
        }
    }

    override var minWidth: CGFloat { image.role == .thumb ? GenUIMetrics.thumb : 80 }
    override var fills: Bool { image.role != .thumb }
    override var isLeading: Bool { image.role == .thumb }

    override func place(_ frame: CGRect, below: CGFloat) -> GenUIPlaced {
        let radius: CGFloat = switch image.role {
        case .figure: GenUIMetrics.imageRadius
        case .cover: GenUIMetrics.coverRadius
        case .thumb: GenUIMetrics.thumbRadius
        case .tile: 0
        }
        var placed = GenUIPlaced(key: key, frame: frame, mark: .image(image, radius: radius))
        if let overlay, let text = image.overlay {
            let bounds = CGRect(origin: .zero, size: frame.size)
            placed.children.append(GenUIPlaced(key: "\(key).dim", frame: bounds, mark: .surface(GenUISurface(fill: Self.dim))))
            placed.children.append(genuiLabel("\(key).overlay", overlay, plain: text, frame: bounds))
        }
        return placed
    }
}

/// `code`: a mono well that scrolls sideways and never wraps, its title or
/// language and a copy control over it.
final class GenUICodeElement: GenUIElement {
    private static let headerHeight: CGFloat = 32
    private static let padding: CGFloat = 12
    private let code: GenUICode
    private let header: NSAttributedString
    private let body: ChatTextLayout

    init(key: String, _ code: GenUICode, context: GenUIPlanContext) {
        self.code = code
        header = genuiLine(code.title ?? code.language ?? "", ChatTextStyles.genuiMicro, Palette.genuiTertiary, in: context.environment)
        let paragraph = NSMutableParagraphStyle()
        paragraph.minimumLineHeight = 20
        paragraph.maximumLineHeight = 20
        body = ChatTextLayout(unwrapped: NSAttributedString(string: code.text, attributes: [
            .font: Fonts.mono(bold: false, size: 13), .foregroundColor: UIColor(Palette.syntaxDefault), .paragraphStyle: paragraph,
        ]))
        super.init(key: key)
    }

    override func natural(_ width: CGFloat) -> CGSize { CGSize(width: width, height: Self.headerHeight + ceil(body.size.height) + Self.padding) }
    override var minWidth: CGFloat { 160 }

    override func place(_ frame: CGRect, below: CGFloat) -> GenUIPlaced {
        let p = Self.padding
        let h = Self.headerHeight
        var placed = GenUIPlaced(key: key, frame: frame, mark: .surface(GenUISurface(fill: Palette.genuiCode, radius: GenUIMetrics.noticeRadius, clips: true)))
        placed.children.append(genuiLabel("\(key).header", header, plain: code.title ?? code.language ?? "", frame: CGRect(x: p, y: 0, width: max(0, frame.width - 2 * p - 32), height: h)))
        placed.children.append(GenUIPlaced(key: "\(key).copy", frame: CGRect(x: frame.width - 40, y: 0, width: 40, height: h), mark: .copy(code.text, rect: CGRect(x: 12, y: 8, width: 16, height: 16))))
        let textSize = CGSize(width: ceil(body.size.width), height: ceil(body.size.height))
        var scroll = GenUIPlaced(
            key: "\(key).scroll", frame: CGRect(x: 0, y: h, width: frame.width, height: frame.height - h),
            mark: .scroll(GenUIScrollMark(contentSize: CGSize(width: textSize.width + 2 * p, height: frame.height - h), stops: []))
        )
        scroll.children.append(GenUIPlaced(key: "\(key).text", frame: CGRect(x: p, y: 0, width: textSize.width, height: textSize.height), mark: .text(GenUITextMark(layout: body, links: [], plain: code.text))))
        placed.children.append(scroll)
        return placed
    }
}
#endif
