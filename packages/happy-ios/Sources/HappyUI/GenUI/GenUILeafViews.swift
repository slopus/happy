#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

// MARK: - Text

/// `text`: spans in the typography its role calls for. Strong is a heavier
/// Figtree, emphasis its oblique, code the mono face a point and a half
/// smaller on the code well's tint, a link underlined; tapping a link
/// reports an `open` action.
final class GenUITextView: GenUIElementView {
    private let label = UILabel()
    private let text: GenUIText
    private let style: ChatTextStyle
    private let base: [NSAttributedString.Key: Any]
    private var links: [(range: NSRange, url: String)] = []
    private weak var context: GenUIContext?

    init(key: String, _ text: GenUIText, place: GenUIViewPlace, context: GenUIContext) {
        self.text = text
        self.context = context
        let (style, color, tabular) = Self.look(text.role, inCard: place.inCard)
        self.style = style
        let ink = text.tone.flatMap { GenUIColors.tints($0) ? $0.text : nil } ?? color
        let lines = switch text.overflow {
        case .wrap: 0
        case .clamp: 2
        case .truncate: 1
        }
        let font = tabular ? Fonts.tabular(style.font) : style.font
        base = style.attributes(
            color: UIColor(ink), font: font, alignment: place.columnEnd ?? (text.align == .end) ? .right : .natural,
            lineBreakMode: lines == 0 ? .byWordWrapping : .byTruncatingTail
        )
        super.init(key: key)
        label.numberOfLines = lines
        label.lineBreakMode = lines == 0 ? .byWordWrapping : .byTruncatingTail
        label.attributedText = attributed()
        addSubview(label)
        if !links.isEmpty {
            addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped(_:))))
            accessibilityTraits = .link
        }
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

    private func attributed() -> NSAttributedString {
        let result = NSMutableAttributedString()
        let font = base[.font] as? UIFont ?? style.font
        for span in text.spans {
            var attributes = base
            if span.code {
                attributes[.font] = Fonts.mono(bold: span.strong, size: style.size - 1.5)
                attributes[.backgroundColor] = UIColor(Palette.genuiCode)
            } else if span.strong || span.emphasis {
                let weight: ChatWeight = span.strong ? .semibold : (style.face.weight ?? .regular)
                let face: ChatFace = span.emphasis ? .figtreeOblique(weight) : .figtree(weight)
                attributes[.font] = ChatTextStyle(face, size: style.size, lineHeight: style.lineHeight).font
            } else {
                attributes[.font] = font
            }
            if let link = span.link {
                attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue
                links.append((NSRange(location: result.length, length: (span.text as NSString).length), link))
            }
            result.append(NSAttributedString(string: style.uppercase ? span.text.uppercased() : span.text, attributes: attributes))
        }
        return result
    }

    override func natural(_ width: CGFloat) -> CGSize {
        let size = label.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        return CGSize(width: min(width, ceil(size.width)), height: ceil(size.height))
    }

    override func baseline(_ width: CGFloat) -> CGFloat {
        let font = base[.font] as? UIFont ?? style.font
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

    override func layoutSubviews() {
        super.layoutSubviews()
        label.frame = bounds
    }

    @objc private func tapped(_ gesture: UITapGestureRecognizer) {
        guard let attributed = label.attributedText else { return }
        let storage = NSTextStorage(attributedString: attributed)
        let manager = NSLayoutManager()
        let container = NSTextContainer(size: label.bounds.size)
        container.lineFragmentPadding = 0
        container.maximumNumberOfLines = label.numberOfLines
        container.lineBreakMode = label.lineBreakMode
        manager.addTextContainer(container)
        storage.addLayoutManager(manager)
        let point = gesture.location(in: label)
        let index = manager.characterIndex(for: point, in: container, fractionOfDistanceBetweenInsertionPoints: nil)
        let hit = links.first { NSLocationInRange(index, $0.range) } ?? (links.count == 1 ? links[0] : nil)
        if let hit { context?.activate(key, .open(hit.url), group: nil) }
    }
}

private extension ChatFace {
    var weight: ChatWeight? {
        if case .figtree(let weight) = self { return weight }
        return nil
    }
}

// MARK: - Glyphs and status

/// `icon`: one glyph, `leading` at a row's or header's size, `inline` at a
/// line of text's. A name with no glyph takes no room.
final class GenUIIconView: GenUIElementView {
    private let glyph = UIImageView()
    private let side: CGFloat
    private let role: GenUIIcon.Role

    init(key: String, _ icon: GenUIIcon) {
        role = icon.role
        side = icon.role == .leading ? GenUIMetrics.leadingIcon : GenUIMetrics.inlineIcon
        super.init(key: key)
        glyph.image = GenUIIcons.image(icon.name)
        glyph.tintColor = UIColor(icon.tone.ink)
        glyph.contentMode = .scaleAspectFit
        addSubview(glyph)
    }

    override func natural(_ width: CGFloat) -> CGSize {
        glyph.image == nil ? .zero : CGSize(width: min(width, side), height: side)
    }

    /// Centred on the cap height of the text beside it.
    override func baseline(_ width: CGFloat) -> CGFloat { side / 2 + 4.5 }
    override var minWidth: CGFloat { glyph.image == nil ? 0 : side }
    override var fills: Bool { false }
    override var neighbour: GenUIMetrics.Neighbour { .text }
    override var isLeading: Bool { true }

    override func layoutSubviews() {
        super.layoutSubviews()
        glyph.frame = CGRect(x: 0, y: 0, width: bounds.width, height: min(bounds.height, side))
    }
}

/// `pill`: a short status label on its tone's soft fill.
final class GenUIPillView: GenUIElementView {
    private let icon = UIImageView()
    private let label = UILabel()
    private let hasIcon: Bool

    init(key: String, _ pill: GenUIPill) {
        let image = pill.icon.flatMap(GenUIIcons.image)
        hasIcon = image != nil
        super.init(key: key)
        backgroundColor = UIColor(pill.tone.fill)
        layer.cornerRadius = GenUIMetrics.pillHeight / 2
        layer.cornerCurve = .continuous
        let ink = pill.tone.text
        icon.image = image
        icon.tintColor = UIColor(pill.tone.ink)
        icon.contentMode = .scaleAspectFit
        label.attributedText = genuiString(pill.text, ChatTextStyles.genuiBadge, ink, truncates: true)
        if hasIcon { addSubview(icon) }
        addSubview(label)
        isAccessibilityElement = true
        accessibilityLabel = pill.text
    }

    override func natural(_ width: CGFloat) -> CGSize {
        typealias M = GenUIMetrics
        let iconWidth = hasIcon ? M.pillIcon + M.pillIconGap : 0
        let text = ceil(min(label.intrinsicContentSize.width, M.pillMaxText))
        return CGSize(width: min(width, M.pillPaddingH * 2 + iconWidth + text), height: M.pillHeight)
    }

    override func baseline(_ width: CGFloat) -> CGFloat { GenUIMetrics.pillHeight / 2 + 4 }
    override var minWidth: CGFloat { measure(.greatestFiniteMagnitude).width }
    override var fills: Bool { false }
    override var neighbour: GenUIMetrics.Neighbour { .text }

    override func layoutSubviews() {
        super.layoutSubviews()
        typealias M = GenUIMetrics
        var x = M.pillPaddingH
        if hasIcon {
            icon.frame = CGRect(x: x, y: (bounds.height - M.pillIcon) / 2, width: M.pillIcon, height: M.pillIcon)
            x += M.pillIcon + M.pillIconGap
        }
        label.frame = CGRect(x: x, y: 0, width: max(0, bounds.width - x - M.pillPaddingH), height: bounds.height)
    }
}

/// `button`: filled, outlined, a plain link or a chip. A destructive
/// action is never the filled one. In a group the chosen one keeps an
/// accent ring and the others dim and stop taking taps.
final class GenUIButtonView: GenUIElementView, GenUIChoice {
    private let control = UIControl()
    private let label = UILabel()
    private let icon = UIImageView()
    private let variant: GenUIButton.Variant

    init(key: String, _ button: GenUIButton, context: GenUIContext) {
        let variant = button.tone == .danger && button.variant == .primary ? .secondary : button.variant
        self.variant = variant
        let fill: UIColor
        let ink: ColorToken
        switch variant {
        case .primary:
            fill = UIColor(Palette.primaryButton)
            ink = Palette.primaryButtonInk
        case .secondary, .chip:
            fill = button.tone == .danger ? .clear : UIColor(Palette.button)
            ink = button.tone == .neutral || button.tone == .muted ? Palette.cardTitle : button.tone.text
        case .plain:
            fill = .clear
            ink = button.tone == .neutral ? GenUITone.accent.text : button.tone.text
        }
        super.init(key: key)
        control.backgroundColor = fill
        control.layer.cornerRadius = GenUIMetrics.buttonRadius
        control.layer.cornerCurve = .continuous
        if variant == .secondary || variant == .chip {
            control.layer.borderWidth = 1
            control.layer.borderColor = (button.tone == .danger ? UIColor(GenUITone.danger.ink).withAlphaComponent(0.5) : UIColor(Palette.divider)).cgColor
        }
        addSubview(control)
        label.attributedText = genuiString(button.label, ChatTextStyles.genuiButton, ink, alignment: .center, truncates: true)
        label.isUserInteractionEnabled = false
        addSubview(label)
        if let name = button.icon, let image = GenUIIcons.image(name) {
            icon.image = image
            icon.tintColor = UIColor(ink)
            icon.contentMode = .scaleAspectFit
            icon.isUserInteractionEnabled = false
            addSubview(icon)
        }
        control.accessibilityLabel = button.label
        control.accessibilityTraits = .button
        control.isAccessibilityElement = true
        control.addAction(UIAction { [weak context, key] _ in context?.activate(key, button.action, group: button.group) }, for: .touchUpInside)
        control.addAction(UIAction { [weak self] _ in self?.alpha = 0.6 }, for: [.touchDown, .touchDragEnter])
        control.addAction(UIAction { [weak self] _ in self?.alpha = 1 }, for: [.touchUpInside, .touchUpOutside, .touchDragExit, .touchCancel])
        context.join(button.group, self)
    }

    private var height: CGFloat { variant == .chip ? GenUIMetrics.chipHeight : GenUIMetrics.buttonHeight }
    private var padding: CGFloat { variant == .chip ? GenUIMetrics.chipPaddingH : GenUIMetrics.buttonPaddingH }
    private var iconWidth: CGFloat { icon.superview == nil ? 0 : GenUIMetrics.buttonIcon + GenUIMetrics.buttonIconGap }

    override func natural(_ width: CGFloat) -> CGSize {
        CGSize(width: min(width, ceil(label.intrinsicContentSize.width) + iconWidth + 2 * padding), height: height)
    }

    override func baseline(_ width: CGFloat) -> CGFloat { height / 2 + 5 }
    override var minWidth: CGFloat { measure(.greatestFiniteMagnitude).width }
    override var fills: Bool { false }
    override var neighbour: GenUIMetrics.Neighbour { .other }

    func show(chosen: Bool) {
        control.isEnabled = false
        if chosen {
            control.backgroundColor = UIColor(GenUITone.accent.fill)
            control.layer.borderWidth = 1.5
            control.layer.borderColor = UIColor(GenUITone.accent.ink).cgColor
            control.accessibilityTraits = [.button, .selected]
        } else {
            alpha = 0.4
            control.accessibilityTraits = [.button, .notEnabled]
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        control.frame = bounds
        let textWidth = min(ceil(label.intrinsicContentSize.width), bounds.width - 2 * padding - iconWidth)
        let x = (bounds.width - textWidth - iconWidth) / 2
        if icon.superview != nil { icon.frame = CGRect(x: x, y: 0, width: GenUIMetrics.buttonIcon, height: bounds.height) }
        label.frame = CGRect(x: x + iconWidth, y: 0, width: max(0, textWidth), height: bounds.height)
    }
}

// MARK: - Drawings

/// `bar`: a progress track filled to its value.
final class GenUIBarView: GenUIElementView {
    private let track = UIView()
    private let fill = UIView()
    private let value: Double

    init(key: String, _ bar: GenUIBar) {
        value = bar.value
        super.init(key: key)
        track.backgroundColor = UIColor(GenUITone.neutral.fill)
        track.layer.cornerRadius = GenUIMetrics.bar / 2
        track.clipsToBounds = true
        fill.backgroundColor = UIColor(bar.tone.ink)
        fill.layer.cornerRadius = GenUIMetrics.bar / 2
        addSubview(track)
        track.addSubview(fill)
        isAccessibilityElement = true
        accessibilityTraits = .updatesFrequently
        accessibilityValue = "\(Int((value * 100).rounded()))%"
    }

    override func natural(_ width: CGFloat) -> CGSize { CGSize(width: width, height: GenUIMetrics.bar) }
    override var minWidth: CGFloat { 60 }

    override func layoutSubviews() {
        super.layoutSubviews()
        track.frame = bounds
        fill.frame = CGRect(x: 0, y: 0, width: bounds.width * CGFloat(value), height: bounds.height)
    }
}

/// `marker`: a step's status as the shared drawing, one diameter for every
/// status, in the ink of the tone the theme gives it: a disc with a check
/// (done) or a cross (failed) in the card's colour, a ring with a dot half
/// its size (active, the dot breathing), an empty ring (pending). The rail
/// down to the next step is a hairline-coloured line that runs past this
/// view's top square to the bottom of its frame.
final class GenUIMarkerView: GenUIElementView {
    private static let ring: CGFloat = 1.5
    private let status: GenUIMarker.Status
    private let disc = UIView()
    private let glyph = UIImageView()
    private let dot = UIView()
    private let railView = UIView()
    private let freezes: Bool
    let hasRail: Bool

    init(key: String, _ marker: GenUIMarker, freezes: Bool) {
        status = marker.status
        hasRail = marker.rail
        self.freezes = freezes
        super.init(key: key)
        let ink = UIColor(GenUIColors.marker(marker.status.rawValue).ink)
        railView.backgroundColor = UIColor(Palette.divider)
        if hasRail { addSubview(railView) }
        addSubview(disc)
        switch marker.status {
        case .done, .failed:
            disc.backgroundColor = ink
            glyph.image = GenUIIcons.image(marker.status == .done ? "check" : "x")
            glyph.tintColor = UIColor(Palette.cardFill)
            glyph.contentMode = .scaleAspectFit
            disc.addSubview(glyph)
        case .active, .pending:
            disc.layer.borderWidth = Self.ring
            disc.layer.borderColor = ink.cgColor
            if marker.status == .active {
                dot.backgroundColor = ink
                disc.addSubview(dot)
            }
            registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: GenUIMarkerView, _) in
                view.disc.layer.borderColor = ink.resolvedColor(with: view.traitCollection).cgColor
            }
        }
        isAccessibilityElement = true
        accessibilityLabel = marker.status.rawValue
    }

    override func natural(_ width: CGFloat) -> CGSize { CGSize(width: GenUIMetrics.marker, height: GenUIMetrics.marker) }
    override func baseline(_ width: CGFloat) -> CGFloat { GenUIMetrics.marker / 2 + 5 }
    override var minWidth: CGFloat { GenUIMetrics.marker }
    override var fills: Bool { false }
    override var isLeading: Bool { true }

    override func layoutSubviews() {
        super.layoutSubviews()
        let side = GenUIMetrics.marker
        let railTop = side + 4
        railView.frame = CGRect(x: side / 2 - GenUIMetrics.rail / 2, y: railTop, width: GenUIMetrics.rail, height: max(0, bounds.height - 4 - railTop))
        disc.frame = CGRect(x: 0, y: 0, width: side, height: side)
        disc.layer.cornerRadius = side / 2
        glyph.frame = disc.bounds.insetBy(dx: 4, dy: 4)
        dot.frame = disc.bounds.insetBy(dx: side / 4, dy: side / 4)
        dot.layer.cornerRadius = side / 4
        if status == .active, !freezes, dot.layer.animation(forKey: "pulse") == nil {
            let pulse = CABasicAnimation(keyPath: "opacity")
            pulse.fromValue = 1
            pulse.toValue = 0.35
            pulse.duration = 0.9
            pulse.autoreverses = true
            pulse.repeatCount = .infinity
            pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            dot.layer.add(pulse, forKey: "pulse")
        }
    }
}

/// `spark`: a tiny trend line fitted to its box, a soft wash under it and
/// a dot on the newest value.
final class GenUISparkView: GenUIElementView {
    private let values: [Double]
    private let color: ColorToken

    init(key: String, _ spark: GenUISpark) {
        values = spark.values
        color = spark.tone.ink
        super.init(key: key)
        isOpaque = false
        contentMode = .redraw
        isAccessibilityElement = false
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: GenUISparkView, _) in view.setNeedsDisplay() }
    }

    override func natural(_ width: CGFloat) -> CGSize { CGSize(width: width, height: GenUIMetrics.spark) }
    override var minWidth: CGFloat { 60 }

    override func draw(_ rect: CGRect) {
        guard values.count > 1, let context = UIGraphicsGetCurrentContext() else { return }
        let low = values.min() ?? 0
        let high = values.max() ?? 1
        let span = high > low ? high - low : 1
        let box = bounds.insetBy(dx: 3, dy: 3)
        let points = values.enumerated().map { index, value in
            CGPoint(x: box.minX + box.width * CGFloat(index) / CGFloat(values.count - 1), y: box.maxY - box.height * CGFloat((value - low) / span))
        }
        let line = UIBezierPath()
        line.move(to: points[0])
        points.dropFirst().forEach(line.addLine)
        let ink = UIColor(color)
        let wash = UIBezierPath(cgPath: line.cgPath)
        wash.addLine(to: CGPoint(x: points[points.count - 1].x, y: bounds.maxY))
        wash.addLine(to: CGPoint(x: points[0].x, y: bounds.maxY))
        wash.close()
        context.saveGState()
        wash.addClip()
        if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [ink.withAlphaComponent(0.16).cgColor, ink.withAlphaComponent(0).cgColor] as CFArray, locations: [0, 1]) {
            context.drawLinearGradient(gradient, start: CGPoint(x: 0, y: box.minY), end: CGPoint(x: 0, y: bounds.maxY), options: [])
        }
        context.restoreGState()
        ink.setStroke()
        line.lineWidth = 1.5
        line.lineJoinStyle = .round
        line.lineCapStyle = .round
        line.stroke()
        let last = points[points.count - 1]
        ink.setFill()
        UIBezierPath(ovalIn: CGRect(x: last.x - 2.5, y: last.y - 2.5, width: 5, height: 5)).fill()
    }
}

/// `code`: a mono well that scrolls sideways, its title or language and a
/// copy button over it. Copying is the block's own control, not an action.
final class GenUICodeView: GenUIElementView {
    private let header = UILabel()
    private let copy = UIButton(type: .system)
    private let scroll = UIScrollView()
    private let text = UILabel()
    private static let headerHeight: CGFloat = 32
    private static let padding: CGFloat = 12

    init(key: String, _ code: GenUICode) {
        super.init(key: key)
        backgroundColor = UIColor(Palette.genuiCode)
        layer.cornerRadius = GenUIMetrics.noticeRadius
        layer.cornerCurve = .continuous
        clipsToBounds = true
        header.attributedText = genuiString(code.title ?? code.language ?? "", ChatTextStyles.genuiMicro, Palette.genuiTertiary, truncates: true)
        addSubview(header)
        copy.setImage(GenUIIcons.image("copy", side: 16), for: .normal)
        copy.tintColor = UIColor(GenUITone.neutral.text)
        copy.accessibilityLabel = "Copy"
        // A check for a moment once it's copied.
        copy.addAction(UIAction { [weak copy] _ in
            UIPasteboard.general.string = code.text
            copy?.setImage(GenUIIcons.image("check", side: 16), for: .normal)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copy?.setImage(GenUIIcons.image("copy", side: 16), for: .normal) }
        }, for: .touchUpInside)
        addSubview(copy)
        scroll.showsHorizontalScrollIndicator = false
        addSubview(scroll)
        let paragraph = NSMutableParagraphStyle()
        paragraph.minimumLineHeight = 20
        paragraph.maximumLineHeight = 20
        text.numberOfLines = 0
        text.attributedText = NSAttributedString(string: code.text, attributes: [
            .font: Fonts.mono(bold: false, size: 13), .foregroundColor: UIColor(Palette.syntaxDefault), .paragraphStyle: paragraph,
        ])
        scroll.addSubview(text)
    }

    private lazy var textSize: CGSize = text.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude))

    override func natural(_ width: CGFloat) -> CGSize { CGSize(width: width, height: Self.headerHeight + ceil(textSize.height) + Self.padding) }
    override var minWidth: CGFloat { 160 }

    override func layoutSubviews() {
        super.layoutSubviews()
        let p = Self.padding
        header.frame = CGRect(x: p, y: 0, width: max(0, bounds.width - 2 * p - 32), height: Self.headerHeight)
        copy.frame = CGRect(x: bounds.width - 40, y: 0, width: 40, height: Self.headerHeight)
        scroll.frame = CGRect(x: 0, y: Self.headerHeight, width: bounds.width, height: bounds.height - Self.headerHeight)
        text.frame = CGRect(x: p, y: 0, width: ceil(textSize.width), height: ceil(textSize.height))
        scroll.contentSize = CGSize(width: ceil(textSize.width) + 2 * p, height: scroll.bounds.height)
    }
}
#endif
