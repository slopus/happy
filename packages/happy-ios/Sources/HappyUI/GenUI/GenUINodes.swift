#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit
import UltraView

/// A plan as Ultraview nodes: one node per placed element at its planned
/// frame. Built off the main thread; Ultraview lays the nodes out, draws
/// them on its display queue and the main thread only applies the result.
struct GenUIBuilt: @unchecked Sendable {
    let plan: GenUIPlan
    let root: UltraNode
    /// The appearance its drawings were first made for.
    let dark: Bool
    /// Nodes whose drawing follows light and dark, and how to draw each.
    let drawn: [(node: UltraNode, make: @Sendable (_ dark: Bool) -> any Drawing)]
    /// The elements of single-choice groups, by key.
    let choices: [String: GenUIChoiceNodes]
    /// Carousels that settle one card at a time.
    let snaps: [(node: UltraScrollNode, stops: [CGFloat])]
    /// Pictures still to load, over their ThumbHash.
    let images: [(node: UltraNode, file: String)]
}

/// A choice's nodes: what its group's answer changes.
struct GenUIChoiceNodes: @unchecked Sendable {
    enum Look {
        /// A press: its ground takes the accent's soft fill.
        case press(ground: UltraNode)
        /// A button: an accent ring on the accent's soft fill.
        case button
    }

    let group: String
    let node: UltraNode
    let look: Look
}

/// Something drawn with UIKit into an Ultraview bitmap, in light or dark.
struct GenUIDrawing: Drawing {
    let dark: Bool
    let body: @Sendable (CGRect) -> Void

    func draw(in context: CGContext, bounds: CGRect) {
        UITraitCollection(userInterfaceStyle: dark ? .dark : .light).performAsCurrent {
            UIGraphicsPushContext(context)
            body(bounds)
            UIGraphicsPopContext()
        }
    }
}

/// A picture filling its box, cropped and centred.
struct GenUIPictureDrawing: Drawing {
    let image: UIImage

    func draw(in context: CGContext, bounds: CGRect) {
        guard image.size.width > 0, image.size.height > 0 else { return }
        let scale = max(bounds.width / image.size.width, bounds.height / image.size.height)
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        UIGraphicsPushContext(context)
        image.draw(in: CGRect(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2, width: size.width, height: size.height))
        UIGraphicsPopContext()
    }
}

extension Color {
    /// A token's light and dark values.
    init(_ token: ColorToken) {
        func color(_ rgba: RGBA) -> Color { Color(red: rgba.red, green: rgba.green, blue: rgba.blue, alpha: rgba.alpha) }
        self = .dynamic(light: color(token.light), dark: color(token.dark))
    }
}

/// Builds a plan's nodes. Used on one thread at a time.
final class GenUINodeBuilder {
    private let interaction: GenUIInteraction
    private let dark: Bool
    private var drawn: [(node: UltraNode, make: @Sendable (Bool) -> any Drawing)] = []
    private var choices: [String: GenUIChoiceNodes] = [:]
    private var snaps: [(node: UltraScrollNode, stops: [CGFloat])] = []
    private var images: [(node: UltraNode, file: String)] = []

    private init(interaction: GenUIInteraction, dark: Bool) {
        self.interaction = interaction
        self.dark = dark
    }

    /// `interaction` hears the nodes' taps; `dark` is the appearance they
    /// are first drawn in.
    static func build(_ plan: GenUIPlan, interaction: GenUIInteraction, dark: Bool) -> GenUIBuilt {
        let builder = GenUINodeBuilder(interaction: interaction, dark: dark)
        let root = builder.node(plan.root, absolute: false)
        return GenUIBuilt(plan: plan, root: root, dark: dark, drawn: builder.drawn, choices: builder.choices, snaps: builder.snaps, images: builder.images)
    }

    private func style(_ frame: CGRect, absolute: Bool = true) -> Style {
        var style = Style()
        if absolute {
            style.position = .absolute
            style.left = .points(frame.minX)
            style.top = .points(frame.minY)
        }
        style.width = .points(frame.width)
        style.height = .points(frame.height)
        style.flexShrink = 0
        return style
    }

    private func draws(_ node: UltraNode, _ make: @escaping @Sendable (CGRect) -> Void) {
        let factory: @Sendable (Bool) -> any Drawing = { dark in GenUIDrawing(dark: dark, body: make) }
        node.drawing = factory(dark)
        drawn.append((node, factory))
    }

    /// One placed element and everything under it. Each mark is built by a
    /// method of its own, so this frame, recursed once per level, stays small.
    private func node(_ placed: GenUIPlaced, absolute: Bool = true) -> UltraNode {
        let style = style(placed.frame, absolute: absolute)
        switch placed.mark {
        case .group: return holding(UltraNode(style: style), placed.children)
        case .surface(let surface): return self.surface(placed, surface, style)
        case .hairline: return hairline(style)
        case .text(let text): return self.text(placed.key, text, style)
        case .glyph(let name, let ink, let rect): return glyph(name, ink, rect, style)
        case .bar(let value, let ink): return bar(value, ink, placed.frame, style)
        case .marker(let status, let rail): return marker(status, rail, style)
        case .spark(let values, let ink): return spark(values, ink, style)
        case .plot(let shape): return plot(shape, style)
        case .image(let image, let radius): return self.image(placed.key, image, radius, placed.frame, style)
        case .scroll(let scroll): return self.scroll(placed, scroll, style)
        case .press(let press): return self.press(placed, press, style)
        case .button(let button): return self.button(placed, button, style)
        case .copy(let text, let rect): return copy(text, rect, style)
        }
    }

    private func holding(_ node: UltraNode, _ children: [GenUIPlaced]) -> UltraNode {
        for child in children { node.addChild(self.node(child)) }
        return node
    }

    private func surface(_ placed: GenUIPlaced, _ surface: GenUISurface, _ style: Style) -> UltraNode {
        var style = style
        if let fill = surface.fill { style.backgroundColor = Color(fill) }
        if surface.radius > 0 { style.borderRadius = surface.radius }
        if surface.clips { style.overflow = .hidden }
        let node = holding(UltraNode(style: style), placed.children)
        // A border takes room in layout like padding, which would move
        // the planned children: it is drawn by a node of its own, over them.
        if let border = surface.border, surface.borderWidth > 0 {
            var ring = self.style(CGRect(origin: .zero, size: placed.frame.size))
            ring.borderColor = Color(border)
            ring.borderWidth = surface.borderWidth
            ring.borderRadius = surface.radius
            ring.pointerEvents = .none
            node.addChild(UltraNode(style: ring))
        }
        return node
    }

    private func hairline(_ style: Style) -> UltraNode {
        var style = style
        style.backgroundColor = Color(Palette.divider)
        return UltraNode(style: style)
    }

    private func text(_ key: String, _ text: GenUITextMark, _ style: Style) -> UltraNode {
        let node = UltraNode(style: style)
        let layout = text.layout
        draws(node) { bounds in
            // Set in its frame as a label sets it: centred down it.
            layout.draw(at: CGPoint(x: 0, y: max(0, (bounds.height - layout.size.height) / 2)))
        }
        node.accessibility = Accessibility(label: text.plain, role: .text)
        if let link = text.links.first?.url {
            node.onPress = { [weak interaction = self.interaction] in interaction?.activate(key, .open(link), group: nil) }
            node.accessibility.role = .link
        }
        return node
    }

    private func glyph(_ name: String, _ ink: ColorToken, _ rect: CGRect, _ style: Style) -> UltraNode {
        let node = UltraNode(style: style)
        draws(node) { _ in GenUIIcons.draw(name, in: rect, ink: UIColor(ink)) }
        return node
    }

    private func bar(_ value: Double, _ ink: ColorToken, _ frame: CGRect, _ style: Style) -> UltraNode {
        var style = style
        style.backgroundColor = Color(GenUITone.neutral.fill)
        style.borderRadius = frame.height / 2
        style.overflow = .hidden
        let node = UltraNode(style: style)
        var fill = self.style(CGRect(x: 0, y: 0, width: frame.width * CGFloat(value), height: frame.height))
        fill.backgroundColor = Color(ink)
        fill.borderRadius = frame.height / 2
        node.addChild(UltraNode(style: fill))
        node.accessibility = Accessibility(label: "\(Int((value * 100).rounded()))%", isElement: true)
        return node
    }

    private func marker(_ status: GenUIMarker.Status, _ rail: Bool, _ style: Style) -> UltraNode {
        let node = UltraNode(style: style)
        draws(node) { bounds in GenUIMarks.marker(status, rail: rail, in: bounds) }
        node.accessibility = Accessibility(label: status.rawValue, isElement: true)
        return node
    }

    private func spark(_ values: [Double], _ ink: ColorToken, _ style: Style) -> UltraNode {
        let node = UltraNode(style: style)
        draws(node) { bounds in GenUIMarks.spark(values, ink: UIColor(ink), in: bounds) }
        return node
    }

    private func plot(_ shape: GenUIPlotShape, _ style: Style) -> UltraNode {
        let node = UltraNode(style: style)
        draws(node) { bounds in
            guard let context = UIGraphicsGetCurrentContext() else { return }
            shape.draw(in: context, bounds: bounds)
        }
        node.accessibility = Accessibility(label: shape.plot.summary, role: .image)
        return node
    }

    private func image(_ key: String, _ image: GenUIImage, _ radius: CGFloat, _ frame: CGRect, _ style: Style) -> UltraNode {
        var style = style
        style.backgroundColor = Color(GenUITone.neutral.fill)
        style.borderRadius = radius
        style.overflow = .hidden
        let node = UltraNode(style: style)
        if let placeholder = ThumbHashImages.image(image.thumbhash) { node.drawing = GenUIPictureDrawing(image: placeholder) }
        images.append((node, image.file))
        if let text = image.overlay {
            // The last tile of a cut-off gallery, dimmed under how many more.
            var dim = self.style(CGRect(origin: .zero, size: frame.size))
            dim.backgroundColor = Color(red: 0, green: 0, blue: 0, alpha: 0.45)
            dim.pointerEvents = .none
            let label = UltraNode(style: dim)
            label.drawing = GenUIDrawing(dark: dark) { bounds in
                let string = NSAttributedString(string: text, attributes: [.font: Fonts.ui(.semiBold, size: 22), .foregroundColor: UIColor.white])
                let size = string.size()
                string.draw(at: CGPoint(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2))
            }
            node.addChild(label)
        }
        node.accessibility = Accessibility(label: image.alt, role: .image)
        if let viewer = image.viewer {
            node.onPress = { [weak interaction = self.interaction] in interaction?.onViewer?(key, viewer.group, viewer.index) }
            node.pressedOpacity = 0.85
            node.accessibility.role = .button
        }
        return node
    }

    private func scroll(_ placed: GenUIPlaced, _ scroll: GenUIScrollMark, _ style: Style) -> UltraNode {
        var content = Style()
        content.width = .points(scroll.contentSize.width)
        content.height = .points(scroll.contentSize.height)
        let node = UltraScrollNode(style: style, contentContainerStyle: content, horizontal: true, children: placed.children.map { self.node($0) })
        node.showsHorizontalScrollIndicator = false
        if !scroll.stops.isEmpty { snaps.append((node, scroll.stops)) }
        return node
    }

    private func press(_ placed: GenUIPlaced, _ press: GenUIPressMark, _ style: Style) -> UltraNode {
        let node = UltraNode(style: style)
        // The pressed ground sits under the content, past it into the gaps.
        var groundStyle = self.style(press.ground)
        groundStyle.borderRadius = press.radius
        groundStyle.pointerEvents = .none
        let ground = UltraNode(style: groundStyle)
        node.addChild(ground)
        for child in placed.children {
            let content = self.node(child)
            content.accessibility.hidden = true
            node.addChild(content)
        }
        node.accessibility = Accessibility(label: press.label, role: press.action == nil ? .none : .button, isElement: true)
        guard let action = press.action else { return node }
        let key = placed.key
        let group = press.group
        node.onPress = { [weak interaction = self.interaction] in interaction?.activate(key, action, group: group) }
        if press.role == .tile {
            node.pressedOpacity = 0.6
        } else {
            node.onPressIn = { ground.updateStyle { $0.backgroundColor = Color(Palette.rowPressed) } }
            node.onPressOut = { ground.updateStyle { $0.backgroundColor = nil } }
        }
        if let group { choices[key] = GenUIChoiceNodes(group: group, node: node, look: .press(ground: ground)) }
        return node
    }

    private func button(_ placed: GenUIPlaced, _ button: GenUIButtonMark, _ style: Style) -> UltraNode {
        var style = style
        if let fill = button.surface.fill { style.backgroundColor = Color(fill) }
        if let border = button.surface.border {
            style.borderColor = Color(border)
            style.borderWidth = button.surface.borderWidth
        }
        style.borderRadius = button.surface.radius
        let node = UltraNode(style: style)
        // The label and icon are planned from the button's outer edge;
        // its border's room is taken back.
        let inset = button.surface.border == nil ? 0 : button.surface.borderWidth
        for child in placed.children {
            var shifted = child
            shifted.frame = child.frame.offsetBy(dx: -inset, dy: -inset)
            let content = self.node(shifted)
            content.accessibility.hidden = true
            node.addChild(content)
        }
        node.accessibility = Accessibility(label: button.label, role: .button)
        let key = placed.key
        let action = button.action
        let group = button.group
        node.onPress = { [weak interaction = self.interaction] in interaction?.activate(key, action, group: group) }
        node.pressedOpacity = 0.6
        if let group { choices[key] = GenUIChoiceNodes(group: group, node: node, look: .button) }
        return node
    }

    private func copy(_ text: String, _ rect: CGRect, _ style: Style) -> UltraNode {
        let node = UltraNode(style: style)
        let copied = GenUICopied()
        let factory: @Sendable (Bool) -> any Drawing = { dark in
            GenUIDrawing(dark: dark) { _ in GenUIIcons.draw(copied.shown ? "check" : "copy", in: rect, ink: UIColor(GenUITone.neutral.text)) }
        }
        node.drawing = factory(dark)
        drawn.append((node, factory))
        node.accessibility = Accessibility(label: "Copy", role: .button)
        let dark = dark
        node.onPress = { [weak node] in
            UIPasteboard.general.string = text
            // A check for a moment once it's copied.
            copied.shown = true
            node?.drawing = factory(dark)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                copied.shown = false
                node?.drawing = factory(dark)
            }
        }
        return node
    }
}

/// Whether a code block's copy control shows its check.
private final class GenUICopied: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false

    var shown: Bool {
        get { lock.withLock { value } }
        set { lock.withLock { value = newValue } }
    }
}

/// The drawings that aren't text: a step marker and a sparkline.
enum GenUIMarks {
    /// One diameter for every status, in the ink of the tone the theme
    /// gives it: a disc with a check (done) or a cross (failed) in the
    /// card's colour, a ring with a dot half its size (active), an empty
    /// ring (pending). The rail to the next step is a hairline-coloured
    /// line down the rest of `bounds`.
    static func marker(_ status: GenUIMarker.Status, rail: Bool, in bounds: CGRect) {
        let side = GenUIMetrics.marker
        let ring: CGFloat = 1.5
        let ink = UIColor(GenUIColors.marker(status.rawValue).ink)
        if rail {
            let top = side + 4
            UIColor(Palette.divider).setFill()
            UIRectFill(CGRect(x: side / 2 - GenUIMetrics.rail / 2, y: top, width: GenUIMetrics.rail, height: max(0, bounds.height - 4 - top)))
        }
        let disc = CGRect(x: 0, y: 0, width: side, height: side)
        switch status {
        case .done, .failed:
            ink.setFill()
            UIBezierPath(ovalIn: disc).fill()
            GenUIIcons.draw(status == .done ? "check" : "x", in: disc.insetBy(dx: 4, dy: 4), ink: UIColor(Palette.cardFill))
        case .active, .pending:
            ink.setStroke()
            let circle = UIBezierPath(ovalIn: disc.insetBy(dx: ring / 2, dy: ring / 2))
            circle.lineWidth = ring
            circle.stroke()
            if status == .active {
                ink.setFill()
                UIBezierPath(ovalIn: disc.insetBy(dx: side / 4, dy: side / 4)).fill()
            }
        }
    }

    /// A tiny trend line fitted to its box, a soft wash under it and a dot
    /// on the newest value.
    static func spark(_ values: [Double], ink: UIColor, in bounds: CGRect) {
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
#endif
