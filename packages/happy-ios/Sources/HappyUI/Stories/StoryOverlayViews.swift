#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// One overlay on a frame, drawn from its data at its unscaled size; the
/// canvas places it at its centre and turns and scales it. Every kind draws
/// the same on the viewer, the editor and the inline story.
class StoryOverlayView: UIView {
    private(set) var overlay: StoryOverlay

    init(_ overlay: StoryOverlay) {
        self.overlay = overlay
        super.init(frame: .zero)
        isOpaque = false
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    var id: String { overlay.id ?? "" }

    /// Takes a changed overlay of the same kind; false when it can't. Only
    /// moving it draws nothing again.
    func update(_ overlay: StoryOverlay) -> Bool {
        let redraw = !Self.sameLook(overlay, self.overlay)
        self.overlay = overlay
        if redraw { setNeedsDisplay() }
        return true
    }

    /// The same overlay but for where it is.
    static func sameLook(_ a: StoryOverlay, _ b: StoryOverlay) -> Bool {
        var a = a, b = b
        a.transform = .fitted
        b.transform = .fitted
        return a == b
    }

    /// The unscaled size on a canvas of `canvas`.
    func baseSize(canvas: CGSize) -> CGSize { .zero }

    /// Whether the canvas scales this view by `transform.scale`, or the
    /// size already includes it.
    var scalesWithTransform: Bool { false }

    /// Places it on a canvas of `canvas`, in the canvas's coordinates.
    func place(canvas: CGSize) {
        guard let t = overlay.transform else { return }
        let size = CGRect(origin: .zero, size: baseSize(canvas: canvas))
        // Bounds and centre hold under a transform; only a new size draws again.
        if bounds != size {
            bounds = size
            setNeedsLayout()
            setNeedsDisplay()
        }
        center = StoryCanvasLayout.center(t.x, t.y, canvas: canvas)
        var turned = CGAffineTransform(rotationAngle: CGFloat(t.rotation))
        if scalesWithTransform { turned = turned.scaledBy(x: CGFloat(t.scale), y: CGFloat(t.scale)) }
        transform = turned
    }

    static func make(_ overlay: StoryOverlay, media: StoriesMedia?) -> StoryOverlayView? {
        switch overlay {
        case .text: StoryTextOverlayView(overlay)
        case .link: StoryLinkOverlayView(overlay)
        case .emoji: StoryEmojiOverlayView(overlay)
        case .reaction: StoryReactionOverlayView(overlay)
        case .sticker: StoryStickerOverlayView(overlay, media: media)
        case .unknown: nil
        }
    }
}

// MARK: Text

/// Telegram's text entity: the font at 1/16 of the canvas's width, wrapped
/// at its width, and its colour used as the fill says: the text itself, a
/// rounded box per line behind contrasting text (whole or at half), an
/// outline around white text, or white text on a frosted box.
final class StoryTextOverlayView: StoryOverlayView {
    private var blur: UIVisualEffectView?

    override var scalesWithTransform: Bool { true }

    static func font(_ font: StoryTextFont, size: CGFloat) -> UIFont {
        let name: String? = switch font {
        case .sanFrancisco: nil
        case .typewriter: "AmericanTypewriter"
        case .avenirNext: "AvenirNext-DemiBoldItalic"
        case .courierNew: "CourierNewPS-BoldMT"
        case .noteworthy: "Noteworthy-Bold"
        case .georgia: "Georgia-Bold"
        case .papyrus: "Papyrus"
        case .snellRoundhand: "SnellRoundhand-Bold"
        }
        return name.flatMap { UIFont(name: $0, size: size) } ?? .systemFont(ofSize: size, weight: .semibold)
    }

    /// Black text on a light box, white on a dark one.
    static func contrasting(_ color: UIColor) -> UIColor {
        var (r, g, b, a): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        color.getRed(&r, green: &g, blue: &b, alpha: &a)
        return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6 ? .black : .white
    }

    private struct Measured {
        var text: NSAttributedString
        var lines: [CGRect]
        var size: CGSize
        /// Where the wrapped text is drawn from, its first line flush with the box.
        var origin: CGPoint
        var padding: CGSize
        var wrap: CGFloat
        var radius: CGFloat
    }

    private var measured: (canvas: CGSize, overlay: StoryOverlay, value: Measured)?

    /// The text's font and paragraph on a canvas of `canvas`; with `inked`
    /// its colours as the fill uses them too.
    static func attributes(_ style: StoryTextStyle, canvas: CGSize, inked: Bool = true) -> [NSAttributedString.Key: Any] {
        let font = Self.font(style.font, size: StoryCanvasLayout.textFontSize(canvas: canvas))
        let color = UIColor(hex: style.color) ?? .white
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = switch style.align { case .left: .left; case .center: .center; case .right: .right }
        var attributes: [NSAttributedString.Key: Any] = [.font: font, .paragraphStyle: paragraph]
        guard inked else { return attributes }
        switch style.fill {
        case .regular: attributes[.foregroundColor] = color
        case .filled: attributes[.foregroundColor] = Self.contrasting(color)
        case .semi: attributes[.foregroundColor] = Self.contrasting(color)
        case .stroke:
            attributes[.foregroundColor] = UIColor.white
            attributes[.strokeColor] = color
            attributes[.strokeWidth] = -5
        case .blur: attributes[.foregroundColor] = UIColor.white
        }
        return attributes
    }

    /// Where the wrapped text is laid out in this view's unscaled points:
    /// the editor types into a text view placed there.
    func textFrame(canvas: CGSize) -> CGRect? {
        guard let measured = measure(canvas: canvas) else { return nil }
        return CGRect(x: measured.origin.x, y: measured.origin.y, width: measured.wrap, height: measured.size.height - 2 * measured.padding.height)
    }

    private func measure(canvas: CGSize) -> Measured? {
        guard case .text(_, let string, let style, _) = overlay else { return nil }
        if let measured, measured.canvas == canvas, Self.sameLook(measured.overlay, overlay) { return measured.value }
        let size = StoryCanvasLayout.textFontSize(canvas: canvas)
        let text = NSAttributedString(string: string, attributes: Self.attributes(style, canvas: canvas))
        let wrap = StoryCanvasLayout.textWrap(style.width, canvas: canvas)
        let padding = CGSize(width: size * 0.35, height: size * 0.12)
        let storage = NSTextStorage(attributedString: text)
        let manager = NSLayoutManager()
        let container = NSTextContainer(size: CGSize(width: wrap, height: .greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        manager.addTextContainer(container)
        storage.addLayoutManager(manager)
        manager.ensureLayout(for: container)
        var lines: [CGRect] = []
        manager.enumerateLineFragments(forGlyphRange: manager.glyphRange(for: container)) { _, used, _, _, _ in
            lines.append(used)
        }
        // No text yet is a box around where the caret stands.
        let caret: CGFloat = switch style.align { case .left: 0; case .center: wrap / 2; case .right: wrap }
        let usedWidth = lines.map(\.maxX).max() ?? caret
        let usedMin = lines.map(\.minX).min() ?? caret
        let height = ceil(manager.usedRect(for: container).height)
        // The box is the lines' extent, so alignment holds within it.
        let shift = usedMin
        let box = CGSize(width: ceil(usedWidth - usedMin) + 2 * padding.width, height: height + 2 * padding.height)
        let placed = lines.map { $0.offsetBy(dx: padding.width - shift, dy: padding.height) }
        let value = Measured(text: text, lines: placed, size: box, origin: CGPoint(x: padding.width - shift, y: padding.height), padding: padding, wrap: wrap, radius: size * 0.3)
        measured = (canvas, overlay, value)
        return value
    }

    private var canvasSize: CGSize = .zero

    override func baseSize(canvas: CGSize) -> CGSize {
        canvasSize = canvas
        return measure(canvas: canvas)?.size ?? .zero
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard case .text(_, _, let style, _) = overlay else { return }
        if style.fill == .blur {
            let view = blur ?? UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialDark))
            if blur == nil { insertSubview(view, at: 0); blur = view }
            view.frame = bounds
            view.clipsToBounds = true
            view.layer.cornerRadius = measure(canvas: canvasSize)?.radius ?? 0
            view.isUserInteractionEnabled = false
        } else {
            blur?.removeFromSuperview(); blur = nil
        }
    }

    override func draw(_ rect: CGRect) {
        guard case .text(_, _, let style, _) = overlay, let measured = measure(canvas: canvasSize),
              let context = UIGraphicsGetCurrentContext() else { return }
        if style.fill == .filled || style.fill == .semi {
            let color = (UIColor(hex: style.color) ?? .white).withAlphaComponent(style.fill == .semi ? 0.5 : 1)
            context.setFillColor(color.cgColor)
            // One rounded box per line, overlapping into one shape.
            let path = UIBezierPath()
            for line in measured.lines where line.width > 0 {
                path.append(UIBezierPath(roundedRect: line.insetBy(dx: -measured.padding.width, dy: -measured.padding.height), cornerRadius: measured.radius))
            }
            path.usesEvenOddFillRule = false
            path.fill()
        }
        measured.text.draw(with: CGRect(x: measured.origin.x, y: measured.origin.y, width: measured.wrap, height: bounds.height), options: [.usesLineFragmentOrigin], context: nil)
    }
}

// MARK: Link

/// A link pill: a link glyph and the label (or the host), 1/12 of the
/// canvas's width tall at scale 1, in one of five styles.
final class StoryLinkOverlayView: StoryOverlayView {
    private let icon = UIImageView()
    private let label = UILabel()
    private var blur: UIVisualEffectView?

    override init(_ overlay: StoryOverlay) {
        super.init(overlay)
        clipsToBounds = true
        icon.contentMode = .scaleAspectFit
        addSubview(icon)
        addSubview(label)
        apply()
    }

    override var scalesWithTransform: Bool { true }

    override func update(_ overlay: StoryOverlay) -> Bool {
        _ = super.update(overlay)
        apply()
        return true
    }

    static func title(_ overlay: StoryOverlay) -> String {
        guard case .link(_, let url, let label, _, _, _) = overlay else { return "" }
        if let label, !label.isEmpty { return label }
        return URL(string: url)?.host?.replacingOccurrences(of: "www.", with: "", options: .anchored) ?? url
    }

    private var colors: (fill: UIColor, ink: UIColor, blurred: Bool) {
        guard case .link(_, _, _, let style, let color, _) = overlay else { return (.white, .black, false) }
        switch style {
        case .white: return (.white, .black, false)
        case .black: return (.black, .white, false)
        case .transparent: return (UIColor.white.withAlphaComponent(0.25), .white, false)
        case .blur: return (.clear, .white, true)
        case .custom:
            let fill = color.flatMap(UIColor.init(hex:)) ?? .white
            return (fill, StoryTextOverlayView.contrasting(fill), false)
        }
    }

    private func apply() {
        let colors = colors
        backgroundColor = colors.fill
        label.textColor = colors.ink
        icon.tintColor = colors.ink
        label.text = Self.title(overlay)
        if colors.blurred, blur == nil {
            let view = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialDark))
            view.isUserInteractionEnabled = false
            insertSubview(view, at: 0)
            blur = view
        } else if !colors.blurred {
            blur?.removeFromSuperview(); blur = nil
        }
        setNeedsLayout()
    }

    private var height: CGFloat = 0

    override func baseSize(canvas: CGSize) -> CGSize {
        height = StoryCanvasLayout.linkHeight(canvas: canvas)
        label.font = .systemFont(ofSize: height * 0.42, weight: .semibold)
        icon.image = UIImage.icon(.ionicons("link-outline"), size: height * 0.5).withRenderingMode(.alwaysTemplate)
        let text = label.sizeThatFits(CGSize(width: canvas.width * 0.8, height: height)).width
        return CGSize(width: ceil(height * 0.3 + height * 0.5 + height * 0.18 + min(text, canvas.width * 0.8) + height * 0.38), height: height)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let h = bounds.height
        layer.cornerRadius = h / 2
        blur?.frame = bounds
        icon.frame = CGRect(x: h * 0.3, y: h * 0.25, width: h * 0.5, height: h * 0.5)
        label.frame = CGRect(x: icon.frame.maxX + h * 0.18, y: 0, width: max(0, bounds.width - icon.frame.maxX - h * 0.18 - h * 0.38), height: h)
    }
}

// MARK: Emoji

/// One emoji in the system's emoji font, its box `scale` of the canvas's width.
final class StoryEmojiOverlayView: StoryOverlayView {
    override func baseSize(canvas: CGSize) -> CGSize {
        guard let t = overlay.transform else { return .zero }
        return StoryCanvasLayout.sticker(pixels: CGSize(width: 1, height: 1), scale: t.scale, canvas: canvas)
    }

    override func draw(_ rect: CGRect) {
        guard case .emoji(_, let emoji, _) = overlay else { return }
        Self.drawEmoji(emoji, in: bounds)
    }

    static func drawEmoji(_ emoji: String, in box: CGRect) {
        let font = UIFont.systemFont(ofSize: box.height * 0.82)
        let text = NSAttributedString(string: emoji, attributes: [.font: font])
        let size = text.size()
        text.draw(at: CGPoint(x: box.midX - size.width / 2, y: box.midY - size.height / 2))
    }
}

// MARK: Reaction

/// A round speech bubble holding one emoji, Telegram's reaction area: white
/// (or dark) with its tail at the bottom left (or right), and once posted
/// the count of people who reacted with it under the emoji.
final class StoryReactionOverlayView: StoryOverlayView {
    /// How many reacted with its emoji; nil hides the count.
    var count: Int? { didSet { if count != oldValue { setNeedsDisplay() } } }
    /// The person's own reaction is this emoji.
    var chosen = false { didSet { if chosen != oldValue { setNeedsDisplay() } } }

    var emoji: String {
        if case .reaction(_, let emoji, _, _, _) = overlay { return emoji }
        return ""
    }

    override func baseSize(canvas: CGSize) -> CGSize {
        guard let t = overlay.transform else { return .zero }
        return StoryCanvasLayout.reaction(scale: t.scale, canvas: canvas)
    }

    override func draw(_ rect: CGRect) {
        guard case .reaction(_, let emoji, let dark, let flipped, _) = overlay, let context = UIGraphicsGetCurrentContext() else { return }
        let side = bounds.width
        let bubble = bounds.insetBy(dx: side * 0.06, dy: side * 0.06)
        let fill: UIColor = dark == true ? UIColor(white: 0, alpha: 0.5) : .white
        context.saveGState()
        context.setShadow(offset: CGSize(width: 0, height: side * 0.02), blur: side * 0.06, color: UIColor(white: 0, alpha: 0.18).cgColor)
        context.setFillColor(fill.cgColor)
        context.fillEllipse(in: bubble)
        // The tail: a small circle and a smaller one beyond it.
        let right = flipped == true
        let tail = CGRect(x: right ? bubble.maxX - side * 0.2 : bubble.minX + side * 0.06, y: bubble.maxY - side * 0.2, width: side * 0.14, height: side * 0.14)
        context.fillEllipse(in: tail)
        let tip = CGRect(x: right ? bubble.maxX - side * 0.04 : bubble.minX - side * 0.04, y: bubble.maxY - side * 0.04, width: side * 0.07, height: side * 0.07)
        context.fillEllipse(in: tip)
        context.restoreGState()
        let hasCount = (count ?? 0) > 0
        let emojiBox = CGRect(x: bubble.midX - side * 0.25, y: bubble.midY - side * (hasCount ? 0.32 : 0.25), width: side * 0.5, height: side * 0.5)
        StoryEmojiOverlayView.drawEmoji(emoji, in: emojiBox)
        if let count, count > 0 {
            let ink: UIColor = dark == true ? .white : .black
            let text = NSAttributedString(string: Self.short(count), attributes: [.font: UIFont.systemFont(ofSize: side * 0.15, weight: .semibold), .foregroundColor: ink])
            let size = text.size()
            text.draw(at: CGPoint(x: bubble.midX - size.width / 2, y: emojiBox.maxY + side * 0.01))
        }
    }

    /// 1234 as "1.2K", as Telegram counts reactions.
    static func short(_ count: Int) -> String {
        if count < 1000 { return "\(count)" }
        let thousands = Double(count) / 1000
        return thousands < 10 ? String(format: "%.1fK", thousands).replacingOccurrences(of: ".0K", with: "K") : "\(Int(thousands))K"
    }
}

// MARK: Sticker

/// A sticker from its pack, its longer side `scale` of the canvas's width.
/// A still one is its picture; an animated one plays in the view the
/// sticker players give it. One the computer no longer serves draws nothing.
final class StoryStickerOverlayView: StoryOverlayView {
    private weak var media: StoriesMedia?
    let content = StoryStickerContentView()
    private var sticker: Sticker?
    private var loading: Task<Void, Never>?

    init(_ overlay: StoryOverlay, media: StoriesMedia?) {
        self.media = media
        super.init(overlay)
        content.isUserInteractionEnabled = false
        addSubview(content)
        load()
    }

    deinit { loading?.cancel() }

    override func update(_ overlay: StoryOverlay) -> Bool {
        guard case .sticker(_, let packId, let stickerId, _) = overlay, case .sticker(_, let was, let wasId, _) = self.overlay else { return false }
        _ = super.update(overlay)
        if packId != was || stickerId != wasId { load() }
        return true
    }

    private func load() {
        guard case .sticker(_, let packId, let stickerId, _) = overlay, let media else { return }
        loading?.cancel()
        loading = Task { [weak self] in
            guard let sticker = await media.sticker(StickerRef(packId: packId, stickerId: stickerId)), let self, !Task.isCancelled else { return }
            self.sticker = sticker
            superview?.setNeedsLayout()
            content.show(sticker, media: media)
        }
    }

    override func baseSize(canvas: CGSize) -> CGSize {
        guard let t = overlay.transform else { return .zero }
        let pixels = sticker.map { CGSize(width: $0.width, height: $0.height) } ?? CGSize(width: 512, height: 512)
        return StoryCanvasLayout.sticker(pixels: pixels, scale: t.scale, canvas: canvas)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        content.frame = bounds
    }

    override func willMove(toWindow newWindow: UIWindow?) {
        super.willMove(toWindow: newWindow)
        content.visible = newWindow != nil
    }
}

/// A sticker's picture or animation, fitted in its bounds. Still `webp`
/// stickers draw here; animated formats are given to their players.
final class StoryStickerContentView: UIView {
    private let image = UIImageView()
    private(set) var sticker: Sticker?
    private var loading: Task<Void, Never>?
    /// Animated stickers play only while visible.
    var visible = true { didSet { if visible != oldValue { animation?.setPlaying(visible && window != nil) } } }
    private var animation: StoryStickerAnimating?
    private weak var media: StoriesMedia?
    /// The pixels the picture was read at; read again only to grow.
    private var readPixels = 0

    override init(frame: CGRect) {
        super.init(frame: frame)
        image.contentMode = .scaleAspectFit
        addSubview(image)
    }

    deinit { loading?.cancel() }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func show(_ sticker: Sticker, media: StoriesMedia) {
        guard sticker != self.sticker else { return }
        self.sticker = sticker
        self.media = media
        loading?.cancel()
        image.image = nil
        readPixels = 0
        animation?.view.removeFromSuperview()
        animation = nil
        switch sticker.format {
        case .webp:
            readPicture()
        case .tgs, .webm:
            guard let player = StoryStickerPlayers.make?(sticker, media) else { return }
            animation = player
            player.view.isUserInteractionEnabled = false
            addSubview(player.view)
            player.view.frame = bounds
            player.setPlaying(visible && window != nil)
        }
    }

    /// A still sticker at the size it is drawn, once it has one.
    private func readPicture() {
        guard let sticker, sticker.format == .webp, let media, bounds.width > 0 else { return }
        let pixels = min(512, Int(max(bounds.width, bounds.height) * traitCollection.displayScale))
        guard pixels > readPixels else { return }
        readPixels = pixels
        loading?.cancel()
        loading = Task { [weak self] in
            let picture = await media.stickerImage(sticker, pixels: pixels)
            guard let self, !Task.isCancelled, self.sticker == sticker, let picture else { return }
            image.image = picture
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        image.frame = bounds
        animation?.view.frame = bounds
        readPicture()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        animation?.setPlaying(visible && window != nil)
    }
}

/// An animated sticker's player: a view that loops while playing.
@MainActor
protocol StoryStickerAnimating: AnyObject {
    var view: UIView { get }
    func setPlaying(_ playing: Bool)
}

/// Where animated sticker players come from: Lottie for `tgs`
/// (`StoryStickerLottiePlayer`); `webm` has none on iOS (no VP9 with
/// alpha in the platform, and no software decoder bundled), so those draw
/// nothing. Replaceable for tests; nil draws nothing for any.
@MainActor
enum StoryStickerPlayers {
    static var make: ((Sticker, StoriesMedia) -> StoryStickerAnimating?)? = { sticker, media in
        sticker.format == .tgs ? StoryStickerLottiePlayer(sticker: sticker, media: media) : nil
    }
}

extension UIColor {
    /// `#RRGGBB`.
    convenience init?(hex: String) {
        guard hex.count == 7, hex.hasPrefix("#"), let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
        self.init(red: CGFloat((value >> 16) & 0xFF) / 255, green: CGFloat((value >> 8) & 0xFF) / 255, blue: CGFloat(value & 0xFF) / 255, alpha: 1)
    }

    /// `#RRGGBB` of this colour.
    var hexString: String {
        var (r, g, b, a): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        getRed(&r, green: &g, blue: &b, alpha: &a)
        return String(format: "#%02X%02X%02X", Int((r * 255).rounded()), Int((g * 255).rounded()), Int((b * 255).rounded()))
    }
}
#endif
