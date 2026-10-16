#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

extension ChatWeight {
    var uiWeight: UIFont.Weight {
        switch self {
        case .regular: .regular
        case .medium: .medium
        case .semibold: .semibold
        case .bold: .bold
        }
    }
}

extension ChatTextStyle {
    var font: UIFont {
        switch face {
        case .plex(let face): Fonts.font(face, size: size)
        case .system(let weight): .systemFont(ofSize: size, weight: weight.uiWeight)
        case .systemItalic: .italicSystemFont(ofSize: size)
        case .menlo: UIFont(name: "Menlo-Regular", size: size) ?? .monospacedSystemFont(ofSize: size, weight: .regular)
        case .menloBold: UIFont(name: "Menlo-Bold", size: size) ?? .monospacedSystemFont(ofSize: size, weight: .semibold)
        case .menloItalic: UIFont(name: "Menlo-Italic", size: size) ?? .monospacedSystemFont(ofSize: size, weight: .regular)
        }
    }

    /// One line of this style.
    var lineHeightValue: CGFloat {
        lineHeight ?? font.lineHeight.rounded(.up)
    }

    /// `font` where text is drawn in `environment`: at its text size, or
    /// as designed where there is none. Safe off main.
    func font(in environment: TextEnvironment?) -> UIFont {
        environment.map { font(in: $0) } ?? font
    }

    /// Like `TextStyle.attributes`: a fixed line height centres the glyphs in
    /// the line the way React Native does. In an `environment`, the size and
    /// the line height grow by RN's multiplier and the kern stays as given
    /// (`scaled(_:)`); `font` is then the caller's font at that size, and the
    /// text carries its screen's pixels (`chatDisplayScale`).
    func attributes(
        color: UIColor, font: UIFont? = nil, alignment: NSTextAlignment = .natural, lineBreakMode: NSLineBreakMode = .byWordWrapping,
        in environment: TextEnvironment? = nil
    ) -> [NSAttributedString.Key: Any] {
        let style = environment.map { scaled($0.scale) } ?? self
        let font = font ?? self.font(in: environment)
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = alignment
        paragraph.lineBreakMode = lineBreakMode
        var attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color, .paragraphStyle: paragraph]
        if let lineHeight = style.lineHeight {
            paragraph.minimumLineHeight = lineHeight
            paragraph.maximumLineHeight = lineHeight
            attributes[.baselineOffset] = (lineHeight - font.lineHeight) / 4
        }
        if style.letterSpacing != 0 { attributes[.kern] = style.letterSpacing }
        if let environment { attributes[.chatDisplayScale] = environment.displayScale }
        return attributes
    }

    func string(
        _ text: String, color: ColorToken, alignment: NSTextAlignment = .natural, lineBreakMode: NSLineBreakMode = .byWordWrapping,
        in environment: TextEnvironment? = nil
    ) -> NSAttributedString {
        NSAttributedString(
            string: uppercase ? text.uppercased() : text,
            attributes: attributes(color: UIColor(color), alignment: alignment, lineBreakMode: lineBreakMode, in: environment)
        )
    }
}

/// Markdown spans as one attributed paragraph in a block's style: bold and
/// italic swap the face, inline code takes the mono style, links are
/// underlined and carry their URL (`RenderSpans`). In an `environment`,
/// every face is at its text size.
enum ChatSpans {
    static func string(_ spans: [MarkdownSpan], style: ChatTextStyle, color: ColorToken, in environment: TextEnvironment?) -> NSAttributedString {
        let result = NSMutableAttributedString()
        let uiColor = UIColor(color)
        for span in spans {
            var spanStyle = style
            if span.styles.contains(.code) {
                spanStyle = ChatTextStyles.markdownCode
                spanStyle.lineHeight = style.lineHeight
            } else if span.styles.contains(.bold) || span.styles.contains(.semibold) {
                spanStyle = style.with(.plex(.semiBold))
            } else if span.styles.contains(.italic) {
                spanStyle = style.with(.plex(.italic))
            }
            var attributes = style.attributes(color: uiColor, font: spanStyle.font(in: environment), in: environment)
            if let url = span.url, Markdown.isHTTPLink(url) {
                attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue
                attributes[.chatLink] = url
            }
            result.append(NSAttributedString(string: span.text, attributes: attributes))
        }
        return result
    }
}

extension NSAttributedString.Key {
    /// A tappable http(s) link's URL. Not `.link`: that one makes TextKit
    /// recolour the run.
    static let chatLink = NSAttributedString.Key("HappyChatLink")
    /// The pixels per point of the screen text made at a text size is drawn
    /// on (`TextEnvironment.displayScale`), so `ChatTextLayout` rounds its
    /// box up to that screen's pixels. TextKit ignores it.
    static let chatDisplayScale = NSAttributedString.Key("HappyChatDisplayScale")
}

/// Text laid out once at one width and then only drawn.
///
/// TextKit objects may be used from any thread, one thread at a time. This
/// one is built and fully laid out on the measuring queue, then handed to
/// the main thread, which only reads it; nothing mutates it after `init`.
final class ChatTextLayout: @unchecked Sendable {
    /// The width the text was wrapped at.
    let width: CGFloat
    let maxLines: Int
    /// The used size, rounded up to the screen's pixels as React Native
    /// rounds a Text's box, or to whole points for text made at the
    /// designed size, which says no screen (`chatDisplayScale`).
    let size: CGSize
    /// How far in from the wrapping width's left edge the text starts: 0
    /// unless it is centred or set from the right in a width wider than it.
    let leading: CGFloat
    let string: NSAttributedString
    private let manager: NSLayoutManager
    private let container: NSTextContainer
    private let storage: NSTextStorage

    init(_ string: NSAttributedString, width: CGFloat, maxLines: Int = 0) {
        self.string = string
        self.width = width
        self.maxLines = maxLines
        storage = NSTextStorage(attributedString: string)
        manager = NSLayoutManager()
        container = NSTextContainer(size: CGSize(width: max(0, width), height: .greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        container.maximumNumberOfLines = maxLines
        if maxLines > 0 { container.lineBreakMode = .byTruncatingTail }
        manager.addTextContainer(container)
        storage.addLayoutManager(manager)
        if string.length == 0 {
            size = .zero
            leading = 0
        } else {
            manager.ensureLayout(for: container)
            let used = manager.usedRect(for: container)
            let scale = string.attribute(.chatDisplayScale, at: 0, effectiveRange: nil) as? CGFloat ?? 0
            size = CGSize(width: min(PixelGrid.ceil(used.width, scale: scale), max(0, width)), height: PixelGrid.ceil(used.height, scale: scale))
            leading = max(0, used.minX)
        }
    }

    /// Unwrapped: one line per source line, as wide as the longest.
    convenience init(unwrapped string: NSAttributedString) {
        self.init(string, width: 100_000)
    }

    /// Draws into the current context with the text's top-left at `origin`.
    func draw(at origin: CGPoint) {
        guard string.length > 0 else { return }
        let range = manager.glyphRange(for: container)
        manager.drawBackground(forGlyphRange: range, at: origin)
        manager.drawGlyphs(forGlyphRange: range, at: origin)
    }

    /// The character under a point in the text's own coordinates.
    func characterIndex(at point: CGPoint) -> Int? {
        guard string.length > 0, CGRect(origin: .zero, size: size).insetBy(dx: -4, dy: -4).contains(point) else { return nil }
        var fraction: CGFloat = 0
        let glyph = manager.glyphIndex(for: point, in: container, fractionOfDistanceThroughGlyph: &fraction)
        let rect = manager.boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: container)
        guard rect.insetBy(dx: -6, dy: -6).contains(point) else { return nil }
        return manager.characterIndexForGlyph(at: glyph)
    }

    func link(at point: CGPoint) -> String? {
        guard let index = characterIndex(at: point), index < string.length else { return nil }
        return string.attribute(.chatLink, at: index, effectiveRange: nil) as? String
    }
}

/// One piece of text measured at whatever widths a layout asks for. The
/// layout that ends up placed is picked afterwards by its frame, so the
/// text that is drawn is exactly the text that was measured.
final class MeasuredText {
    let string: NSAttributedString
    let maxLines: Int
    private var layouts: [ChatTextLayout] = []

    init(_ string: NSAttributedString, maxLines: Int = 0) {
        self.string = string
        self.maxLines = maxLines
    }

    var measurable: Measurable {
        Measurable { [self] width in layout(width: width).size }
    }

    func layout(width: CGFloat) -> ChatTextLayout {
        if let cached = layouts.first(where: { $0.width == width }) { return cached }
        let layout = ChatTextLayout(string, width: width, maxLines: maxLines)
        layouts.append(layout)
        return layout
    }

    /// The layout measured for a placed frame: one wrapped at the frame's
    /// width, or a wider offer that came out at the same size (a bubble
    /// hugging its text) and starts at its left. Centred text measured
    /// wider sits in the middle of that width, so a frame hugging it is
    /// laid out again at its own width.
    func layout(for frame: CGRect) -> ChatTextLayout {
        if let exact = layouts.first(where: { $0.width == frame.width }) { return exact }
        if let fitting = layouts.first(where: { $0.size.height == frame.height && $0.size.width <= frame.width + 0.5 && $0.leading < 0.5 }) {
            return fitting
        }
        return layout(width: frame.width)
    }
}

/// Draws a `ChatTextLayout`. Nothing is measured here.
final class ChatTextView: UIView {
    var layout: ChatTextLayout? {
        didSet {
            guard layout !== oldValue else { return }
            setNeedsDisplay()
            accessibilityLabel = layout?.string.string
        }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        backgroundColor = .clear
        contentMode = .topLeft
        // Code is clipped at its card until it scrolls sideways.
        clipsToBounds = true
        layer.drawsAsynchronously = true
        isAccessibilityElement = true
        accessibilityTraits = .staticText
        // Dynamic colours resolve when drawn.
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.setNeedsDisplay()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override var frame: CGRect {
        // Content stays top-left while the frame animates; a new size only
        // needs a redraw.
        didSet { if frame.size != oldValue.size { setNeedsDisplay() } }
    }

    override func draw(_ rect: CGRect) {
        layout?.draw(at: .zero)
    }

    func link(at point: CGPoint) -> String? {
        layout?.link(at: point)
    }
}
#endif
