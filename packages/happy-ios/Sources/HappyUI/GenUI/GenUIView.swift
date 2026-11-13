#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyWire
import UIKit

/// A Gen UI render document drawn as one block of an agent's message,
/// across the chat's column. Only the 15 primitives are drawn; every size,
/// surface and colour comes from the app's tokens. A document with nothing
/// drawable shows its `fallback` as text.
///
/// Taps are reported, never run: `onAction` hears the element's key and its
/// action, `onViewer` an image's key and its place in a `viewers` group.
@MainActor
public final class GenUIView: UIView {
    public var onAction: ((_ key: String, _ action: GenUIAction) -> Void)? {
        get { context.onAction }
        set { context.onAction = newValue }
    }

    public var onViewer: ((_ key: String, _ group: String, _ index: Int) -> Void)? {
        get { context.onViewer }
        set { context.onViewer = newValue }
    }

    private let context: GenUIContext
    private let root: GenUIElementView

    /// `baseURL` resolves the document's image files; `margin` is the
    /// chat's side margin, which a bare carousel runs out into.
    public init(document: GenUIRenderDocument, baseURL: URL?, margin: CGFloat = MessageLayout.Metrics.marginH, freezesMotion: Bool = false) {
        context = GenUIContext(document: document, baseURL: baseURL, freezesMotion: freezesMotion)
        let place = GenUIPlace(inCard: false, bleed: margin)
        if let tree = document.tree() {
            root = GenUIElements.make(tree, context: context, place: place)
        } else {
            root = GenUITextView(key: "fallback", GenUIText([GenUISpan(document.fallback)], role: .body), place: place, context: context)
        }
        super.init(frame: .zero)
        addSubview(root)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    public override func sizeThatFits(_ size: CGSize) -> CGSize {
        CGSize(width: size.width, height: root.measure(size.width).height)
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        root.setLayoutFrame(CGRect(x: 0, y: 0, width: bounds.width, height: root.measure(bounds.width).height))
    }
}

/// What every element of one document shares: its images, who hears its
/// taps, and its single-choice groups.
@MainActor
final class GenUIContext {
    let document: GenUIRenderDocument
    let baseURL: URL?
    let freezesMotion: Bool
    var onAction: ((String, GenUIAction) -> Void)?
    var onViewer: ((String, String, Int) -> Void)?
    let images = GenUIImages()
    private var groups: [String: [Weak]] = [:]
    private var chosen: [String: String] = [:]

    private struct Weak {
        weak var member: (any GenUIChoice)?
    }

    init(document: GenUIRenderDocument, baseURL: URL?, freezesMotion: Bool) {
        self.document = document
        self.baseURL = baseURL
        self.freezesMotion = freezesMotion
    }

    func url(_ file: String) -> URL? {
        guard !file.isEmpty, URL(string: file)?.scheme == nil else { return nil }
        return baseURL?.appendingPathComponent(file)
    }

    func join(_ group: String?, _ member: any GenUIChoice) {
        guard let group else { return }
        groups[group, default: []].append(Weak(member: member))
    }

    /// An element was activated: report it, and if it's in a group, mark it
    /// and close the rest. A closed group reports nothing more.
    func activate(_ key: String, _ action: GenUIAction, group: String?) {
        if let group {
            guard chosen[group] == nil else { return }
            chosen[group] = key
            for member in groups[group] ?? [] { member.member?.show(chosen: member.member?.key == key) }
        }
        onAction?(key, action)
    }
}

/// A button or press in a single-choice group.
@MainActor
protocol GenUIChoice: AnyObject {
    var key: String { get }
    /// After the group's choice: true on the chosen one, false on the rest.
    func show(chosen: Bool)
}

/// Where an element sits, decided by its ancestors.
struct GenUIPlace {
    /// In a card: body text at the card's size, carousels bleed to its edge.
    var inCard: Bool
    /// How far a carousel may run past the column on each side.
    var bleed: CGFloat
    /// First among its siblings: a section draws no hairline above it.
    var first = true
    /// In a grid: whether the cell's column aligns to the end. Nil elsewhere.
    var columnEnd: Bool?
}

/// One primitive's view: it measures itself at a width and lays itself out.
@MainActor
class GenUIElementView: UIView {
    let key: String
    private var sizes: [CGFloat: CGSize] = [:]
    /// How far below its frame the next sibling starts, for a step's rail.
    var extendBottom: CGFloat = 0

    init(key: String) {
        self.key = key
        super.init(frame: .zero)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// The natural size offered `width`, cached: content never changes.
    final func measure(_ width: CGFloat) -> CGSize {
        let width = max(0, width)
        if let size = sizes[width] { return size }
        let size = natural(width)
        sizes[width] = size
        return size
    }

    /// No wider than `width`; as wide as the content when it doesn't fill.
    func natural(_ width: CGFloat) -> CGSize { CGSize(width: width, height: 0) }
    /// The first baseline from the top.
    func baseline(_ width: CGFloat) -> CGFloat { measure(width).height }
    /// The narrowest it reads at.
    var minWidth: CGFloat { 0 }
    /// Takes what a row has left.
    var grows: Bool { false }
    /// Takes a stretching column's width.
    var fills: Bool { true }
    var neighbour: GenUIMetrics.Neighbour { .graphic }
    /// Where a list's inset hairline above it starts.
    var dividerInset: CGFloat { 0 }
    /// An element a list's leading column holds (a glyph, a thumbnail, a number).
    var isLeading: Bool { false }

    final var child: GenUIBoxLayout.Child {
        GenUIBoxLayout.Child(
            measure: { [unowned self] in measure($0) }, baseline: { [unowned self] in baseline($0) },
            minWidth: minWidth, grow: grows, fills: fills, fixed: fixed
        )
    }

    /// Keeps its width in a row short of room.
    var fixed: Bool { false }

    override func sizeThatFits(_ size: CGSize) -> CGSize { measure(size.width) }
}

/// Builds the view for a node.
@MainActor
enum GenUIElements {
    static func make(_ node: GenUINode, context: GenUIContext, place: GenUIPlace) -> GenUIElementView {
        switch node.kind {
        case .box(let box, let children): GenUIBoxView(key: node.key, box, children, context: context, place: place)
        case .grid(let grid, let children): GenUIGridView(key: node.key, grid, children, context: context, place: place)
        case .scroll(let shape, let children): GenUIScrollView(key: node.key, shape: shape, children, context: context, place: place)
        case .switcher(let compact, let regular): GenUISwitchView(key: node.key, compact: compact, regular: regular, context: context, place: place)
        case .press(let press, let children): GenUIPressView(key: node.key, press, children, context: context, place: place)
        case .text(let text): GenUITextView(key: node.key, text, place: place, context: context)
        case .icon(let icon): GenUIIconView(key: node.key, icon)
        case .image(let image): GenUIImageView(key: node.key, image, context: context)
        case .pill(let pill): GenUIPillView(key: node.key, pill)
        case .button(let button): GenUIButtonView(key: node.key, button, context: context)
        case .bar(let bar): GenUIBarView(key: node.key, bar)
        case .marker(let marker): GenUIMarkerView(key: node.key, marker, freezes: context.freezesMotion)
        case .spark(let spark): GenUISparkView(key: node.key, spark)
        case .plot(let plot): GenUIPlotView(key: node.key, plot)
        case .code(let code): GenUICodeView(key: node.key, code)
        }
    }
}

// MARK: - Shared pieces

/// One device pixel of the divider colour.
final class GenUIHairline: UIView {
    init() {
        super.init(frame: .zero)
        backgroundColor = UIColor(Palette.divider)
        isUserInteractionEnabled = false
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }
}

/// A control that only shows it is pressed.
final class GenUIPressable: UIControl {
    var pressedColor = UIColor(Palette.rowPressed)
    var restingColor: UIColor = .clear {
        didSet { backgroundColor = restingColor }
    }

    override var isHighlighted: Bool {
        didSet { backgroundColor = isHighlighted ? pressedColor : restingColor }
    }
}

/// Plain text in a style, as the chat sets it.
@MainActor
func genuiString(
    _ text: String, _ style: ChatTextStyle, _ color: ColorToken, alignment: NSTextAlignment = .natural, truncates: Bool = false, tabular: Bool = false
) -> NSAttributedString {
    let font = tabular ? Fonts.tabular(style.font) : style.font
    let attributes = style.attributes(color: UIColor(color), font: font, alignment: alignment, lineBreakMode: truncates ? .byTruncatingTail : .byWordWrapping)
    return NSAttributedString(string: style.uppercase ? text.uppercased() : text, attributes: attributes)
}

/// The shared Gen UI glyphs (Lucide, bundled as `genui-<name>.png` at 1x,
/// 2x and 3x): a black glyph whose alpha is the mask, drawn as a template
/// image in its tone's ink. A name with no glyph draws nothing.
@MainActor
enum GenUIIcons {
    private static var cache: [String: UIImage] = [:]

    static func image(_ name: String) -> UIImage? {
        if let image = cache[name] { return image }
        guard !name.contains("/"), let image = UIImage(named: "genui-\(name)", in: .module, compatibleWith: nil)
            ?? UIImage(named: "GenUI/Icons/genui-\(name)", in: .module, compatibleWith: nil) else { return nil }
        let template = image.withRenderingMode(.alwaysTemplate)
        cache[name] = template
        return template
    }

    /// The glyph drawn at `side` points, for a control that shows its image
    /// at the image's own size.
    static func image(_ name: String, side: CGFloat) -> UIImage? {
        guard let image = image(name) else { return nil }
        let size = CGSize(width: side, height: side)
        return UIGraphicsImageRenderer(size: size).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }.withRenderingMode(.alwaysTemplate)
    }
}

/// The shared Gen UI colours, read once from the bundled `genui-theme.json`.
@MainActor
enum GenUIColors {
    static let theme: GenUITheme? = Bundle.module.url(forResource: "genui-theme", withExtension: "json")
        .flatMap { try? Data(contentsOf: $0) }.flatMap(GenUITheme.parse)

    /// A tone or raw colour by name; a name the theme doesn't know is `neutral`.
    private static func tone(_ table: KeyPath<GenUITheme, [String: ColorToken]>, _ tone: GenUITone) -> ColorToken {
        let colours = theme?[keyPath: table]
        return colours?[tone.name] ?? colours?["neutral"] ?? Palette.textSecondary
    }

    /// Whether `tone` names a colour other than `neutral`, so text in it
    /// leaves its role's colour.
    static func tints(_ tone: GenUITone) -> Bool {
        tone != .neutral && theme?.ink[tone.name] != nil
    }

    static func ink(_ tone: GenUITone) -> ColorToken { self.tone(\.ink, tone) }
    static func text(_ tone: GenUITone) -> ColorToken { self.tone(\.text, tone) }
    static func fill(_ tone: GenUITone) -> ColorToken { self.tone(\.fill, tone) }
    static func series(_ index: Int) -> ColorToken { theme?.series(index) ?? Palette.textSecondary }
    static var muted: ColorToken { theme?.muted ?? Palette.textSecondary }
    static var grid: ColorToken { theme?.grid ?? Palette.divider }
    static var axisLabel: ColorToken { theme?.axisLabel ?? Palette.textSecondary }

    /// A step marker's tone for `status`, as the theme maps it.
    static func marker(_ status: String) -> GenUITone {
        theme?.markers[status].map(GenUITone.init(name:)) ?? .neutral
    }
}

extension GenUITone {
    /// A glyph, a bar, a sparkline, a marker or a chart mark in this tone.
    @MainActor var ink: ColorToken { GenUIColors.ink(self) }
    /// Words in this tone, a pill's label included.
    @MainActor var text: ColorToken { GenUIColors.text(self) }
    /// The ground of a pill or a notice in this tone.
    @MainActor var fill: ColorToken { GenUIColors.fill(self) }
}
#endif
