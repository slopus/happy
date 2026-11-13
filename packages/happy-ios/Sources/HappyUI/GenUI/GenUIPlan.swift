#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// What a Gen UI document's layout depends on besides the document and the
/// width: the person's text size and the screen. Theme, image loading, a
/// press or a choice never change a plan.
struct GenUITraits: Hashable, Sendable {
    /// The text size; nil draws at the designed size.
    var text: TextEnvironment?
    /// The screen's pixels per point, for hairlines.
    var displayScale: CGFloat
    /// How far a bare carousel may run past the column on each side: the
    /// host's side margin.
    var bleed: CGFloat

    init(text: TextEnvironment?, displayScale: CGFloat, bleed: CGFloat = MessageLayout.Metrics.marginH) {
        self.text = text
        self.displayScale = displayScale
        self.bleed = bleed
    }

    var hairline: CGFloat { 1 / max(1, displayScale) }
}

/// A Gen UI document laid out at one width: every element's frame and
/// what it draws. Made off the main thread from the document, the width
/// and the traits alone, and never changed after.
struct GenUIPlan: @unchecked Sendable {
    let width: CGFloat
    let root: GenUIPlaced
    var size: CGSize { root.frame.size }
}

/// One placed element: its frame in its parent's space, what it draws,
/// and what is drawn over it, in order.
struct GenUIPlaced: @unchecked Sendable {
    var key: String
    var frame: CGRect
    var mark: GenUIMark
    var children: [GenUIPlaced] = []
}

/// What a placed element draws. Colours are tokens, resolved when drawn.
enum GenUIMark {
    /// Nothing of its own: it only holds its children.
    case group
    case surface(GenUISurface)
    /// One device pixel of the divider colour.
    case hairline
    /// Text drawn at the top of its frame, centred down it when the frame
    /// is taller, as a label sets it.
    case text(GenUITextMark)
    /// A shared glyph in `rect` (the frame's own space), tinted.
    case glyph(name: String, ink: ColorToken, rect: CGRect)
    case bar(value: Double, ink: ColorToken)
    case marker(GenUIMarker.Status, rail: Bool)
    case spark([Double], ink: ColorToken)
    case plot(GenUIPlotShape)
    case image(GenUIImage, radius: CGFloat)
    /// Content wider than the frame that scrolls sideways; its children
    /// are in the content's space.
    case scroll(GenUIScrollMark)
    /// Its children, tappable.
    case press(GenUIPressMark)
    /// A button's control; its icon and label are its children.
    case button(GenUIButtonMark)
    /// A code block's own copy control, with its glyph in `rect`.
    case copy(String, rect: CGRect)
}

struct GenUISurface {
    var fill: ColorToken?
    var border: ColorToken?
    var borderWidth: CGFloat = 0
    var radius: CGFloat = 0
    var clips = false
}

struct GenUITextMark {
    let layout: ChatTextLayout
    /// Each link's characters and address, for a tap.
    let links: [(range: NSRange, url: String)]
    /// What VoiceOver reads.
    let plain: String
}

struct GenUIScrollMark {
    var contentSize: CGSize
    /// Where a swipe may settle; empty for free scrolling.
    var stops: [CGFloat]
}

struct GenUIPressMark {
    var action: GenUIAction?
    var role: GenUIPress.Role
    var group: String?
    /// The pressed ground, in the press's space: past its content into the
    /// gaps around it, or the content itself for a carousel card.
    var ground: CGRect
    var radius: CGFloat
    /// What VoiceOver reads for it.
    var label: String
}

struct GenUIButtonMark {
    var action: GenUIAction
    var group: String?
    var label: String
    var surface: GenUISurface
}

/// Lays one document out, at any width, from any thread. Each width's plan
/// is made once; the document's elements are read once.
final class GenUIPlanner: @unchecked Sendable {
    let traits: GenUITraits
    private let root: GenUIElement
    private let lock = NSLock()
    private var plans: [CGFloat: GenUIPlan] = [:]

    init(document: GenUIRenderDocument, traits: GenUITraits) {
        self.traits = traits
        let context = GenUIPlanContext(document: document, traits: traits)
        let place = GenUIPlace(inCard: false, bleed: traits.bleed)
        if let tree = document.tree() {
            root = GenUIElements.make(tree, context: context, place: place)
        } else {
            root = GenUITextElement(key: "fallback", GenUIText([GenUISpan(document.fallback)], role: .body), place: place, context: context)
        }
    }

    func plan(width: CGFloat) -> GenUIPlan {
        let width = max(0, width)
        lock.lock()
        defer { lock.unlock() }
        if let plan = plans[width] { return plan }
        let size = root.measure(width)
        let plan = GenUIPlan(width: width, root: root.place(CGRect(x: 0, y: 0, width: width, height: size.height), below: 0))
        plans[width] = plan
        return plan
    }

    func height(width: CGFloat) -> CGFloat { plan(width: width).size.height }
}

/// What every element of one document shares while it is laid out.
final class GenUIPlanContext: @unchecked Sendable {
    let document: GenUIRenderDocument
    let traits: GenUITraits

    init(document: GenUIRenderDocument, traits: GenUITraits) {
        self.document = document
        self.traits = traits
    }

    var environment: TextEnvironment? { traits.text }
    var hairline: CGFloat { traits.hairline }
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

/// One primitive's layout: how it measures at a width, how it sits among
/// its siblings, and what it draws in a frame.
class GenUIElement: @unchecked Sendable {
    let key: String
    private var sizes: [CGFloat: CGSize] = [:]

    init(key: String) {
        self.key = key
    }

    /// The natural size offered `width`, kept: content never changes.
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
    /// Keeps its width in a row short of room.
    var fixed: Bool { false }
    var neighbour: GenUIMetrics.Neighbour { .graphic }
    /// Where a list's inset hairline above it starts.
    var dividerInset: CGFloat { 0 }
    /// An element a list's leading column holds (a glyph, a thumbnail, a number).
    var isLeading: Bool { false }
    /// A step marker whose rail runs down to the next step.
    var hasRail: Bool { false }

    /// The element in `frame`; `below` is how far under the frame its next
    /// sibling starts, which a step's rail runs across.
    func place(_ frame: CGRect, below: CGFloat) -> GenUIPlaced {
        GenUIPlaced(key: key, frame: frame, mark: .group)
    }

    final var child: GenUIBoxLayout.Child {
        GenUIBoxLayout.Child(
            measure: { [unowned self] in measure($0) }, baseline: { [unowned self] in baseline($0) },
            minWidth: minWidth, grow: grows, fills: fills, fixed: fixed
        )
    }
}

/// Builds the layout for a node.
enum GenUIElements {
    static func make(_ node: GenUINode, context: GenUIPlanContext, place: GenUIPlace) -> GenUIElement {
        switch node.kind {
        case .box(let box, let children): GenUIBoxElement(key: node.key, box, children, context: context, place: place)
        case .grid(let grid, let children): GenUIGridElement(key: node.key, grid, children, context: context, place: place)
        case .scroll(let shape, let children): GenUIScrollElement(key: node.key, shape: shape, children, context: context, place: place)
        case .switcher(let compact, let regular): GenUISwitchElement(key: node.key, compact: compact, regular: regular, context: context, place: place)
        case .press(let press, let children): GenUIPressElement(key: node.key, press, children, context: context, place: place)
        case .text(let text): GenUITextElement(key: node.key, text, place: place, context: context)
        case .icon(let icon): GenUIIconElement(key: node.key, icon)
        case .image(let image): GenUIImageElement(key: node.key, image, context: context)
        case .pill(let pill): GenUIPillElement(key: node.key, pill, context: context)
        case .button(let button): GenUIButtonElement(key: node.key, button, context: context)
        case .bar(let bar): GenUIBarElement(key: node.key, bar)
        case .marker(let marker): GenUIMarkerElement(key: node.key, marker)
        case .spark(let spark): GenUISparkElement(key: node.key, spark)
        case .plot(let plot): GenUIPlotElement(key: node.key, plot, context: context)
        case .code(let code): GenUICodeElement(key: node.key, code, context: context)
        }
    }
}

extension GenUIPlaced {
    /// Every placed element under this one, this one first, with its frame
    /// in this one's space. A scroll's content is in the scroll's own space.
    func flattened() -> [(placed: GenUIPlaced, frame: CGRect)] {
        var list: [(GenUIPlaced, CGRect)] = [(self, CGRect(origin: .zero, size: frame.size))]
        func walk(_ placed: GenUIPlaced, origin: CGPoint) {
            for child in placed.children {
                let frame = child.frame.offsetBy(dx: origin.x, dy: origin.y)
                list.append((child, frame))
                if case .scroll = child.mark { continue }
                walk(child, origin: frame.origin)
            }
        }
        walk(self, origin: .zero)
        return list
    }
}
#endif
