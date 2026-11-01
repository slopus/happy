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

    var figtree: Fonts.Weight {
        switch self {
        case .regular: .regular
        case .medium: .medium
        case .semibold: .semiBold
        case .bold: .bold
        }
    }
}

extension ChatTextStyle {
    var font: UIFont {
        switch face {
        case .plex(let face): LegacyFonts.font(face, size: size)
        case .system(let weight): .systemFont(ofSize: size, weight: weight.uiWeight)
        case .systemItalic: .italicSystemFont(ofSize: size)
        case .menlo: UIFont(name: "Menlo-Regular", size: size) ?? .monospacedSystemFont(ofSize: size, weight: .regular)
        case .menloBold: UIFont(name: "Menlo-Bold", size: size) ?? .monospacedSystemFont(ofSize: size, weight: .semibold)
        case .menloItalic: UIFont(name: "Menlo-Italic", size: size) ?? .monospacedSystemFont(ofSize: size, weight: .regular)
        case .figtree(let weight): Fonts.ui(weight.figtree, size: size)
        case .figtreeOblique(let weight):
            // A browser's synthetic oblique: a quarter of the height across.
            UIFont(descriptor: Fonts.ui(weight.figtree, size: size).fontDescriptor.withMatrix(CGAffineTransform(a: 1, b: 0, c: 0.25, d: 1, tx: 0, ty: 0)), size: size)
        }
    }

    /// The face `**strong**` swaps in: desktop's 700 in Figtree, IBM Plex
    /// SemiBold everywhere else, as before.
    var strongFace: ChatFace {
        if case .figtree = face { return .figtree(.bold) }
        return .plex(.semiBold)
    }

    /// The face `*em*` swaps in.
    var emphasisFace: ChatFace {
        if case .figtree(let weight) = face { return .figtreeOblique(weight) }
        return .plex(.italic)
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
/// every face is at its text size. `everyLink` makes any address a link,
/// for a document whose screen resolves its relative ones.
enum ChatSpans {
    static func string(_ spans: [MarkdownSpan], style: ChatTextStyle, color: ColorToken, in environment: TextEnvironment?, everyLink: Bool = false) -> NSAttributedString {
        let result = NSMutableAttributedString()
        let uiColor = UIColor(color)
        for span in spans {
            var spanStyle = style
            if span.styles.contains(.code) {
                spanStyle = ChatTextStyles.markdownCode
                spanStyle.lineHeight = style.lineHeight
            } else if span.styles.contains(.bold) || span.styles.contains(.semibold) {
                spanStyle = style.with(style.strongFace)
            } else if span.styles.contains(.italic) {
                spanStyle = style.with(style.emphasisFace)
            }
            // A person this phone named (never a link an agent typed): in
            // the strong face and the mention's ink, on a tint when it is the reader.
            if let url = span.url, let mention = HappyReferences.mention(link: url) {
                var attributes = style.attributes(color: UIColor(Palette.mention), font: style.with(style.strongFace).font(in: environment), in: environment)
                if mention.me { attributes[.backgroundColor] = UIColor(Palette.mentionMe) }
                result.append(NSAttributedString(string: span.text, attributes: attributes))
                continue
            }
            var attributes = style.attributes(color: uiColor, font: spanStyle.font(in: environment), in: environment)
            // An http(s) link, or a reference this phone wrote (never one an agent typed).
            if let url = span.url, (everyLink && !url.isEmpty) || LegacyMarkdown.isHTTPLink(url) || HappyReferences.reference(link: url) != nil {
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
    // UltraList draws on its display queue while the main thread can hit
    // test the same immutable plan. TextKit itself requires serial access.
    private let access = NSRecursiveLock()

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
    func draw(at origin: CGPoint, visibleRect: CGRect? = nil) {
        access.lock()
        defer { access.unlock() }
        guard string.length > 0 else { return }
        let range = visibleRect.map {
            manager.glyphRange(forBoundingRect: $0.offsetBy(dx: -origin.x, dy: -origin.y), in: container)
        } ?? manager.glyphRange(for: container)
        manager.drawBackground(forGlyphRange: range, at: origin)
        manager.drawGlyphs(forGlyphRange: range, at: origin)
    }

    /// The character under a point in the text's own coordinates.
    func characterIndex(at point: CGPoint) -> Int? {
        access.lock()
        defer { access.unlock() }
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

    /// How far the last line reaches from the left (Telegram's
    /// `trailingLineWidth`): the room after it is where a bubble's time
    /// may go.
    var trailingWidth: CGFloat {
        access.lock()
        defer { access.unlock() }
        guard string.length > 0 else { return 0 }
        let glyphs = manager.glyphRange(for: container)
        guard glyphs.length > 0 else { return 0 }
        let used = manager.lineFragmentUsedRect(forGlyphAt: NSMaxRange(glyphs) - 1, effectiveRange: nil)
        // A text ending in a line break ends on an empty line.
        if string.string.last?.isNewline == true { return 0 }
        return min(width, used.maxX)
    }

    /// Each line as drawn at `origin`, with where each of its characters
    /// ends, for showing a reply a character at a time (`RevealMap`). Off
    /// the main thread: it walks every glyph.
    func revealLines(at origin: CGPoint) -> [RevealMap.Line] {
        access.lock()
        defer { access.unlock() }
        guard string.length > 0 else { return [] }
        var lines: [RevealMap.Line] = []
        let all = manager.glyphRange(for: container)
        manager.enumerateLineFragments(forGlyphRange: all) { [manager] fragment, used, _, glyphs, _ in
            let characters = manager.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
            guard characters.length > 0, glyphs.length > 0 else { return }
            // A glyph's place is where it starts; a character ends where
            // the next glyph starts, the last at the line's used end.
            var starts: [CGFloat] = []
            starts.reserveCapacity(glyphs.length)
            for glyph in glyphs.location..<NSMaxRange(glyphs) {
                starts.append(fragment.minX + manager.location(forGlyphAt: glyph).x)
            }
            var ends: [CGFloat] = []
            ends.reserveCapacity(characters.length)
            var last = used.minX
            for character in characters.location..<NSMaxRange(characters) {
                let glyph = min(max(0, manager.glyphIndexForCharacter(at: character) - glyphs.location), starts.count - 1)
                let end = glyph + 1 < starts.count ? starts[glyph + 1] : used.maxX
                last = max(last, end)
                ends.append(origin.x + last)
            }
            let frame = CGRect(x: origin.x + used.minX, y: origin.y + fragment.minY, width: used.width, height: fragment.height)
            lines.append(RevealMap.Line(frame: frame, ends: ends))
        }
        return lines
    }

    // MARK: Selection

    /// The characters a selection of `range` covers, one rect per line
    /// fragment, from the layout that draws the glyphs: each line's full
    /// height, from the first glyph's left to the last one's right.
    func selectionRects(for range: NSRange) -> [CGRect] {
        access.lock()
        defer { access.unlock() }
        let range = NSIntersectionRange(range, NSRange(location: 0, length: string.length))
        guard range.length > 0 else { return [] }
        let glyphs = manager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        let ns = string.string as NSString
        var rects: [CGRect] = []
        manager.enumerateLineFragments(forGlyphRange: glyphs) { line, _, _, lineGlyphs, _ in
            var part = NSIntersectionRange(lineGlyphs, glyphs)
            // A wrapped line's trailing space and a paragraph's newline are
            // not highlighted: the line's rect stops on its last glyph.
            while part.length > 0, NSMaxRange(part) == NSMaxRange(lineGlyphs) {
                let character = ns.character(at: self.manager.characterIndexForGlyph(at: NSMaxRange(part) - 1))
                guard let scalar = UnicodeScalar(character), CharacterSet.whitespacesAndNewlines.contains(scalar) else { break }
                part.length -= 1
            }
            guard part.length > 0 else { return }
            let box = self.manager.boundingRect(forGlyphRange: part, in: self.container)
            if box.width > 0 { rects.append(CGRect(x: box.minX, y: line.minY, width: box.width, height: line.height)) }
        }
        return rects
    }

    /// The place between characters nearest `point`, in the text's own
    /// coordinates, wherever the point is: a dragged handle's.
    func caretIndex(nearest point: CGPoint) -> Int {
        access.lock()
        defer { access.unlock() }
        guard string.length > 0 else { return 0 }
        var fraction: CGFloat = 0
        let glyph = manager.glyphIndex(for: point, in: container, fractionOfDistanceThroughGlyph: &fraction)
        // Past the last line's foot: its end. Above the first: the start.
        if point.y >= manager.usedRect(for: container).maxY { return string.length }
        if point.y < 0 { return 0 }
        var index = manager.characterIndexForGlyph(at: glyph)
        if fraction > 0.5 { index += 1 }
        // Never after a line's breaking newline: on the line it ends.
        let ns = string.string as NSString
        if index > 0, index <= ns.length, fraction > 0.5, ns.character(at: index - 1) == 0x0A { index -= 1 }
        return min(max(0, index), string.length)
    }

    /// The word around character `index`, as Telegram finds it
    /// (`CFStringTokenizer` by word in the current locale), or the one
    /// character when there is no word there.
    func wordRange(at index: Int) -> NSRange {
        let ns = string.string as NSString
        guard ns.length > 0 else { return NSRange(location: 0, length: 0) }
        let index = min(max(0, index), ns.length - 1)
        let tokenizer = CFStringTokenizerCreate(kCFAllocatorDefault, ns as CFString, CFRange(location: 0, length: ns.length), kCFStringTokenizerUnitWord, CFLocaleCopyCurrent())
        var token = CFStringTokenizerGoToTokenAtIndex(tokenizer, index)
        if token.isEmpty { token = CFStringTokenizerAdvanceToNextToken(tokenizer) }
        let found = CFStringTokenizerGetCurrentTokenRange(tokenizer)
        if !token.isEmpty, found.location <= index, found.location + found.length > index {
            return NSRange(location: found.location, length: found.length)
        }
        return ns.rangeOfComposedCharacterSequence(at: index)
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

    /// The last line's width when wrapped at a width (`trailingWidth`), as
    /// the width of what it measures.
    var trailing: Measurable {
        Measurable { [self] width in CGSize(width: layout(width: width).trailingWidth, height: 0) }
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
class ChatTextView: UIView {
    var layout: ChatTextLayout? {
        didSet {
            guard layout !== oldValue, !Self.drawsAlike(layout, oldValue) else { return }
            setNeedsDisplay()
            accessibilityLabel = layout?.string.string
        }
    }

    /// Its words are on screen, or it has none to draw.
    var isDrawn: Bool { layer.contents != nil || layout == nil || bounds.isEmpty }

    /// The same words at the same width, planned again as a reply streams
    /// on below them: what is drawn stands.
    static func drawsAlike(_ a: ChatTextLayout?, _ b: ChatTextLayout?) -> Bool {
        guard let a, let b else { return false }
        return a.width == b.width && a.size == b.size && a.maxLines == b.maxLines && a.string.isEqual(to: b.string)
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

/// A `ChatTextView` that draws text coming on screen, as UltraList draws
/// its rows (`ChatNodeDrawing`), into a bitmap off the main thread: a row
/// brought in ahead of the scroll costs the main thread nothing to draw.
/// Text on screen with nothing drawn yet is drawn at once, so nothing
/// shows blank; text that grew shows its last drawing meanwhile.
final class ChatOffMainTextView: ChatTextView {
    private var drawing: Task<Void, Never>?
    /// The width the shown bitmap was drawn at.
    private var drawnWidth: CGFloat?
    /// The words the shown bitmap was drawn for.
    private var drawnLayout: ChatTextLayout?
    /// What shows is a drawing of its words as they are now, not of the
    /// fewer they were (a reply coming out reads its glyphs from it).
    var showsItsLayout: Bool {
        layer.contents != nil && (drawnLayout === layout || Self.drawsAlike(drawnLayout, layout))
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        // Another appearance: drawn again at once, with the rest of the screen.
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.forget()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override var layout: ChatTextLayout? {
        didSet {
            // Other words than it showed: none until they are drawn. The
            // same words grown, as a reply streams: the last ones meanwhile.
            guard layout !== oldValue else { return }
            if let old = oldValue?.string, let new = layout?.string, Self.grew(old, into: new) { return }
            forget()
        }
    }

    /// `new` starts with all of `old`, its attributes included.
    private static func grew(_ old: NSAttributedString, into new: NSAttributedString) -> Bool {
        old.length > 0 && new.length >= old.length && new.attributedSubstring(from: NSRange(location: 0, length: old.length)).isEqual(to: old)
    }

    /// Nothing drawn, and nothing on its way.
    private func forget() {
        drawing?.cancel()
        drawing = nil
        layer.contents = nil
        drawnWidth = nil
        drawnLayout = nil
        setNeedsDisplay()
    }

    override func display(_ layer: CALayer) {
        drawing?.cancel()
        drawing = nil
        guard let layout, bounds.width > 0, bounds.height > 0 else {
            layer.contents = nil
            drawnWidth = nil
            drawnLayout = nil
            return
        }
        let size = bounds.size
        let traits = traitCollection
        let scale = layer.contentsScale
        // Another width wraps the words elsewhere: what was drawn is wrong.
        if drawnWidth != size.width { layer.contents = nil }
        // On screen with nothing drawn: now. Words that grew, as a reply
        // streams, keep showing the last of them (pinned top-left) until
        // the rest is drawn.
        if layer.contents == nil, let window, !isInHiddenView, convert(bounds, to: window).intersects(window.bounds) {
            layer.contents = Self.draw(layout, size: size, scale: scale, traits: traits)
            drawnWidth = size.width
            drawnLayout = layout
            return
        }
        drawing = Task { [weak self] in
            let image = await Task.detached(priority: .userInitiated) { Self.draw(layout, size: size, scale: scale, traits: traits) }.value
            // Only for the words and size it was drawn for.
            guard !Task.isCancelled, let self, self.layout === layout, self.bounds.size == size else { return }
            self.layer.contents = image
            self.drawnWidth = size.width
            self.drawnLayout = layout
        }
    }

    /// It or a view it is in is hidden, wherever it sits: UltraList builds
    /// the next row ahead of a scroll hidden at its container's top, on
    /// screen, and drawing its words then held a drag's frame 10 ms.
    private var isInHiddenView: Bool {
        sequence(first: self as UIView, next: \.superview).contains { $0.isHidden }
    }

    private nonisolated static func draw(_ layout: ChatTextLayout, size: CGSize, scale: CGFloat, traits: UITraitCollection) -> CGImage? {
        let format = UIGraphicsImageRendererFormat(for: traits)
        format.scale = scale
        format.opaque = false
        // The palette is sRGB: 8 bits a channel, not the wide format's 16,
        // half the bytes to draw and to hand to the render server.
        format.preferredRange = .standard
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in
            traits.performAsCurrent { layout.draw(at: .zero) }
        }.cgImage
    }
}
#endif
