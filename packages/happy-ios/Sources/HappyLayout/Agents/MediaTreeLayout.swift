import CoreGraphics
import Foundation

/// A layout an agent wrote for media it showed (happy-agent `API.md`, a
/// `tree` layout), laid out at the reading column's width: block flow,
/// flexbox and grid in the subset the daemon allows, as desktop's
/// `MediaTree` draws them in CSS. Nothing paints outside the box, which is
/// never wider than the column nor taller than `maxHeight`.
///
/// An item without a width is drawn at its natural size, shrunk to fit and
/// never enlarged, no taller than `itemMaxHeight` at its own shape; a
/// document or file is a card `cardHeight` tall across its container.
public struct MediaTreeLayout: Equatable, Sendable {
    public static let maxHeight: CGFloat = 1200
    public static let itemMaxHeight: CGFloat = 640
    public static let cardHeight: CGFloat = 64
    /// The tree's own type size and the page's, for `em` and `rem`.
    static let em: CGFloat = 14
    static let rem: CGFloat = 16

    /// One item's box before layout: its shape, and its natural size in points.
    public struct Item {
        public var isCard: Bool
        public var ratio: CGFloat
        public var natural: CGSize?

        public init(isCard: Bool, ratio: CGFloat, natural: CGSize?) {
            self.isCard = isCard
            self.ratio = ratio
            self.natural = natural
        }
    }

    public indirect enum Box {
        case container(Style, [Box])
        case item(index: Int, Style, Item)
        /// A paragraph, measured at a width; `id` names its frame.
        case text(id: Int, Measurable)
    }

    /// Each item's frame by index, each paragraph's by id, and the size.
    public var items: [Int: CGRect] = [:]
    public var texts: [Int: CGRect] = [:]
    public var size: CGSize

    public init(width: CGFloat, root: [Box]) {
        let laid = Self.flow(root, width: max(0, width))
        let height = min(laid.height, Self.maxHeight)
        for placed in laid.placed where placed.frame.minY < height {
            var frame = placed.frame
            frame.size.height = min(frame.height, height - frame.minY)
            switch placed.kind {
            case .item(let index): items[index] = frame
            case .text(let id): texts[id] = frame
            }
        }
        size = CGSize(width: max(0, width), height: height)
    }

    // MARK: Style

    public enum Length: Equatable, Sendable {
        case px(CGFloat)
        case percent(CGFloat)
        case auto

        func resolve(_ base: CGFloat) -> CGFloat? {
            switch self {
            case .px(let value): value
            case .percent(let value): base * value / 100
            case .auto: nil
            }
        }

        static func parse(_ text: String?) -> Length? {
            guard let text else { return nil }
            if text == "0" { return .px(0) }
            if text == "auto" { return .auto }
            for (unit, scale) in [("rem", MediaTreeLayout.rem), ("px", 1), ("em", MediaTreeLayout.em)] where text.hasSuffix(unit) {
                return Double(text.dropLast(unit.count)).map { .px(CGFloat($0) * scale) }
            }
            if text.hasSuffix("%") { return Double(text.dropLast()).map { .percent(CGFloat($0)) } }
            return nil
        }
    }

    public indirect enum Track: Equatable, Sendable {
        case length(Length)
        case fr(CGFloat)
        /// `minmax(min, max)`, `max` a length or a share.
        case minmax(Length, Track)
        case auto
    }

    public struct Style: Equatable, Sendable {
        public enum Display: Sendable { case block, flex, grid, none }

        public var display = Display.block
        public var row = false
        public var reversed = false
        public var wrap = false
        public var grow: CGFloat = 0
        public var shrink: CGFloat = 1
        public var basis: Length?
        public var order = 0
        public var justifyContent = "normal"
        public var alignItems = "normal"
        public var alignSelf = "auto"
        public var justifyItems = "normal"
        public var justifySelf = "auto"
        public var rowGap: Length?
        public var columnGap: Length?
        public var columns: [String]?
        public var autoRows: Length?
        public var columnStart: Int?
        public var columnSpan = 1
        public var width: Length?
        public var height: Length?
        public var minWidth: Length?
        public var maxWidth: Length?
        public var minHeight: Length?
        public var maxHeight: Length?
        public var aspectRatio: CGFloat?
        /// Top, right, bottom, left.
        public var padding: [Length] = [.px(0), .px(0), .px(0), .px(0)]
        public var margin: [Length] = [.px(0), .px(0), .px(0), .px(0)]

        public init() {}

        /// From the normalized CSS values a tree carries.
        public init(_ css: [String: String]) {
            switch css["display"] {
            case "flex", "inline-flex": display = .flex; row = true
            case "grid", "inline-grid": display = .grid
            case "none": display = .none
            default: display = .block
            }
            for word in (css["flexFlow"] ?? "").split(separator: " ") { apply(flexWord: String(word)) }
            if let direction = css["flexDirection"] { apply(flexWord: direction) }
            if let wrap = css["flexWrap"] { apply(flexWord: wrap) }
            if let flex = css["flex"] { applyFlex(flex) }
            if let value = css["flexGrow"].flatMap(Double.init) { grow = CGFloat(value) }
            if let value = css["flexShrink"].flatMap(Double.init) { shrink = CGFloat(value) }
            if let value = css["flexBasis"], value != "content" { basis = Length.parse(value) }
            order = css["order"].flatMap { Int($0) } ?? 0
            justifyContent = css["justifyContent"] ?? Self.second(css["placeContent"]) ?? "normal"
            alignItems = css["alignItems"] ?? Self.first(css["placeItems"]) ?? "normal"
            justifyItems = css["justifyItems"] ?? Self.second(css["placeItems"]) ?? "normal"
            alignSelf = css["alignSelf"] ?? Self.first(css["placeSelf"]) ?? "auto"
            justifySelf = css["justifySelf"] ?? Self.second(css["placeSelf"]) ?? "auto"
            if let gap = css["gap"]?.split(separator: " ").map(String.init) {
                rowGap = Length.parse(gap[0])
                columnGap = Length.parse(gap.count > 1 ? gap[1] : gap[0])
            }
            if let gap = css["rowGap"] { rowGap = Length.parse(gap) }
            if let gap = css["columnGap"] { columnGap = Length.parse(gap) }
            if let template = css["gridTemplateColumns"], template != "none" { columns = Self.tokens(template) }
            autoRows = css["gridAutoRows"].flatMap { Length.parse($0) }
            applyColumn(css["gridColumn"], start: css["gridColumnStart"], end: css["gridColumnEnd"])
            width = Length.parse(css["width"])
            height = Length.parse(css["height"])
            minWidth = Length.parse(css["minWidth"])
            maxWidth = Length.parse(css["maxWidth"])
            minHeight = Length.parse(css["minHeight"])
            maxHeight = Length.parse(css["maxHeight"])
            aspectRatio = css["aspectRatio"].flatMap(Self.ratio)
            padding = Self.edges(css["padding"], css["paddingTop"], css["paddingRight"], css["paddingBottom"], css["paddingLeft"])
            margin = Self.edges(css["margin"], css["marginTop"], css["marginRight"], css["marginBottom"], css["marginLeft"])
        }

        mutating func apply(flexWord word: String) {
            switch word {
            case "row": row = true; reversed = false
            case "row-reverse": row = true; reversed = true
            case "column": row = false; reversed = false
            case "column-reverse": row = false; reversed = true
            case "wrap", "wrap-reverse": wrap = true
            case "nowrap": wrap = false
            default: break
            }
        }

        mutating func applyFlex(_ value: String) {
            let words = value.split(separator: " ").map(String.init)
            switch value {
            case "none": grow = 0; shrink = 0; basis = .auto
            case "auto": grow = 1; shrink = 1; basis = .auto
            default:
                guard let first = words.first else { return }
                if let factor = Double(first) {
                    grow = CGFloat(factor)
                    shrink = 1
                    basis = .px(0)
                    if words.count > 1 {
                        if let factor = Double(words[1]) { shrink = CGFloat(factor) } else { basis = Length.parse(words[1]) }
                    }
                    if words.count > 2 { basis = Length.parse(words[2]) }
                } else {
                    grow = 1; shrink = 1; basis = Length.parse(first)
                }
            }
        }

        mutating func applyColumn(_ shorthand: String?, start: String?, end: String?) {
            var parts = (shorthand ?? "").components(separatedBy: " / ")
            if shorthand == nil { parts = [start ?? "auto", end ?? "auto"] }
            func line(_ text: String) -> (line: Int?, span: Int?) {
                if text.hasPrefix("span ") { return (nil, Int(text.dropFirst(5))) }
                return (Int(text), nil)
            }
            let first = line(parts[0])
            let second: (line: Int?, span: Int?) = parts.count > 1 ? line(parts[1]) : (nil, nil)
            if let begin = first.line, begin > 0 {
                columnStart = begin - 1
                if let end = second.line, end > begin { columnSpan = end - begin } else { columnSpan = second.span ?? 1 }
            } else {
                columnSpan = first.span ?? second.span ?? 1
            }
            columnSpan = max(1, columnSpan)
        }

        static func first(_ pair: String?) -> String? { pair.map { String($0.split(separator: " ").first ?? "") } }
        static func second(_ pair: String?) -> String? {
            guard let words = pair?.split(separator: " ") else { return nil }
            return String(words.count > 1 ? words[words.count - 1] : words[0])
        }

        static func ratio(_ value: String) -> CGFloat? {
            let numbers = value.split(separator: " ").filter { $0 != "auto" && $0 != "/" }.compactMap { Double($0) }
            guard let width = numbers.first, width > 0 else { return nil }
            let height = numbers.count > 1 ? numbers[1] : 1
            return height > 0 ? CGFloat(width / height) : nil
        }

        static func edges(_ all: String?, _ top: String?, _ right: String?, _ bottom: String?, _ left: String?) -> [Length] {
            var edges: [Length] = [.px(0), .px(0), .px(0), .px(0)]
            if let values = all?.split(separator: " ").compactMap({ Length.parse(String($0)) }), !values.isEmpty {
                switch values.count {
                case 1: edges = [values[0], values[0], values[0], values[0]]
                case 2: edges = [values[0], values[1], values[0], values[1]]
                case 3: edges = [values[0], values[1], values[2], values[1]]
                default: edges = Array(values.prefix(4))
                }
            }
            for (index, side) in [top, right, bottom, left].enumerated() { if let value = Length.parse(side) { edges[index] = value } }
            return edges
        }

        /// A value's top-level words, a function kept whole.
        static func tokens(_ text: String) -> [String] {
            var tokens: [String] = []
            var current = ""
            var depth = 0
            for character in text {
                if character == "(" { depth += 1 }
                if character == ")" { depth -= 1 }
                if character == " ", depth == 0 {
                    if !current.isEmpty { tokens.append(current) }
                    current = ""
                } else {
                    current.append(character)
                }
            }
            if !current.isEmpty { tokens.append(current) }
            return tokens
        }
    }

    // MARK: Boxes

    enum Kind { case item(Int), text(Int) }

    struct Placed {
        var kind: Kind
        var frame: CGRect
    }

    /// A box laid out at a width: its border box and what it placed, relative to it.
    struct Laid {
        var width: CGFloat
        var height: CGFloat
        var placed: [Placed] = []

        func offset(_ x: CGFloat, _ y: CGFloat) -> [Placed] {
            placed.map { Placed(kind: $0.kind, frame: $0.frame.offsetBy(dx: x, dy: y)) }
        }
    }

    static func styleOf(_ box: Box) -> Style? {
        switch box {
        case .container(let style, _), .item(_, let style, _): style
        case .text: nil
        }
    }

    static func margins(_ box: Box, base: CGFloat) -> (top: CGFloat, right: CGFloat, bottom: CGFloat, left: CGFloat) {
        guard let margin = styleOf(box)?.margin else { return (0, 0, 0, 0) }
        return (margin[0].resolve(base) ?? 0, margin[1].resolve(base) ?? 0, margin[2].resolve(base) ?? 0, margin[3].resolve(base) ?? 0)
    }

    static func visible(_ boxes: [Box]) -> [Box] {
        let shown = boxes.filter { styleOf($0)?.display != Style.Display.none }
        // `order` sorts, keeping the written order among equals.
        return shown.enumerated().sorted { a, b in
            let (x, y) = (styleOf(a.element)?.order ?? 0, styleOf(b.element)?.order ?? 0)
            return x == y ? a.offset < b.offset : x < y
        }.map(\.element)
    }

    /// The widest a box would like to be, for a flex row's basis.
    static func preferredWidth(_ box: Box, available: CGFloat) -> CGFloat {
        switch box {
        case .text(_, let measurable):
            return min(available, measurable.size(fitting: .greatestFiniteMagnitude).width.rounded(.up))
        case .item(_, let style, let item):
            return layoutItem(style, item, available: available).width
        case .container(let style, _):
            if let width = style.width?.resolve(available) { return min(available, width) }
            return min(available, layout(box, width: available, fill: false).width)
        }
    }

    /// One box at `width`, the room its container gives it. `fill` makes a
    /// container without a width as wide as that room, as a block is.
    static func layout(_ box: Box, width: CGFloat, fill: Bool = true) -> Laid {
        switch box {
        case .text(let id, let measurable):
            let height = measurable.size(fitting: width).height.rounded(.up)
            let used = fill ? width : min(width, measurable.size(fitting: width).width.rounded(.up))
            return Laid(width: used, height: height, placed: [Placed(kind: .text(id), frame: CGRect(x: 0, y: 0, width: used, height: height))])
        case .item(let index, let style, let item):
            let size = layoutItem(style, item, available: width)
            return Laid(width: size.width, height: size.height, placed: [Placed(kind: .item(index), frame: CGRect(origin: .zero, size: size))])
        case .container(let style, let children):
            var outer = style.width?.resolve(width) ?? width
            if let max = style.maxWidth?.resolve(width) { outer = min(outer, max) }
            if let min = style.minWidth?.resolve(width) { outer = Swift.max(outer, min) }
            outer = min(outer, width)
            let padding = style.padding.map { $0.resolve(width) ?? 0 }
            let inner = max(0, outer - padding[1] - padding[3])
            var content: Laid
            switch style.display {
            case .grid: content = grid(style, visible(children), width: inner)
            case .flex: content = style.row ? flexRow(style, visible(children), width: inner) : flexColumn(style, visible(children), width: inner)
            case .block, .none: content = block(visible(children), width: inner)
            }
            let shrinkWraps = !fill && style.width == nil
            let used = shrinkWraps ? min(outer, content.width + padding[1] + padding[3]) : outer
            var height = content.height + padding[0] + padding[2]
            if let ratio = style.aspectRatio, style.height == nil { height = max(height, used / ratio) }
            if let fixed = style.height?.resolve(0) { height = fixed }
            if let min = style.minHeight?.resolve(0) { height = max(height, min) }
            if let max = style.maxHeight?.resolve(0) { height = min(height, max) }
            // Overflow is clipped: nothing paints past the box.
            let placed = content.offset(padding[3], padding[0]).filter { $0.frame.minY < height }
            return Laid(width: used, height: height, placed: placed)
        }
    }

    /// An item's size: its width as asked, else natural and never past the
    /// room; its height from its shape, at most `itemMaxHeight`.
    static func layoutItem(_ style: Style, _ item: Item, available: CGFloat) -> CGSize {
        let ratio = style.aspectRatio ?? item.ratio
        var width = style.width?.resolve(available)
        if item.isCard {
            let card = min(available, width ?? available)
            return CGSize(width: max(0, card), height: cardHeight)
        }
        let height = style.height?.resolve(0)
        if width == nil, let height { width = height * ratio }
        var used = width ?? min(item.natural?.width ?? available, available)
        if let max = style.maxWidth?.resolve(available) { used = min(used, max) }
        if let min = style.minWidth?.resolve(available) { used = Swift.max(used, min) }
        used = max(0, min(used, available))
        var tall = height ?? (ratio > 0 ? used / ratio : used)
        let cap = min(itemMaxHeight, style.maxHeight?.resolve(0) ?? .greatestFiniteMagnitude)
        if tall > cap {
            tall = cap
            if height == nil, width == nil { used = min(used, cap * ratio) }
        }
        return CGSize(width: used, height: tall)
    }

    /// Block flow: one under another, each at its margins; `margin: auto`
    /// on both sides centres a box narrower than the room.
    static func flow(_ boxes: [Box], width: CGFloat) -> Laid {
        block(visible(boxes), width: width)
    }

    static func block(_ boxes: [Box], width: CGFloat) -> Laid {
        var placed: [Placed] = []
        var y: CGFloat = 0
        var used: CGFloat = 0
        var previousBottom: CGFloat = 0
        for (index, box) in boxes.enumerated() {
            let margin = margins(box, base: width)
            // Adjoining vertical margins collapse to the larger.
            if index > 0 { y -= previousBottom; y += max(previousBottom, margin.top) } else { y += margin.top }
            let room = max(0, width - margin.left - margin.right)
            let laid = layout(box, width: room)
            var x = margin.left
            if let style = styleOf(box), style.margin[1] == .auto, style.margin[3] == .auto { x = max(0, (width - laid.width) / 2) }
            else if let style = styleOf(box), style.margin[3] == .auto { x = max(0, width - margin.right - laid.width) }
            placed += laid.offset(x, y)
            y += laid.height + margin.bottom
            previousBottom = margin.bottom
            used = max(used, x + laid.width + margin.right)
        }
        return Laid(width: min(width, used), height: y, placed: placed)
    }

    static func flexColumn(_ style: Style, _ boxes: [Box], width: CGFloat) -> Laid {
        let gap = style.rowGap?.resolve(width) ?? 0
        let ordered = style.reversed ? boxes.reversed() : boxes
        var placed: [Placed] = []
        var y: CGFloat = 0
        var used: CGFloat = 0
        for (index, box) in ordered.enumerated() {
            if index > 0 { y += gap }
            let margin = margins(box, base: width)
            y += margin.top
            let room = max(0, width - margin.left - margin.right)
            let align = alignment(self: styleOf(box)?.alignSelf, items: style.alignItems)
            let laid = layout(box, width: room, fill: align == "stretch")
            let x = margin.left + offset(align, free: room - laid.width)
            placed += laid.offset(x, y)
            y += laid.height + margin.bottom
            used = max(used, x + laid.width + margin.right)
        }
        return Laid(width: min(width, used), height: y, placed: placed)
    }

    static func alignment(self value: String?, items: String) -> String {
        let chosen = (value == nil || value == "auto") ? items : value!
        return chosen == "normal" ? "stretch" : chosen
    }

    static func offset(_ align: String, free: CGFloat) -> CGFloat {
        guard free > 0 else { return 0 }
        switch align {
        case "center": return free / 2
        case "end", "flex-end", "self-end", "right": return free
        default: return 0
        }
    }

    /// A flex row: each box at its basis, lines broken when it wraps, the
    /// free room shared by `flex-grow` or the overflow by `flex-shrink`.
    static func flexRow(_ style: Style, _ boxes: [Box], width: CGFloat) -> Laid {
        let columnGap = style.columnGap?.resolve(width) ?? 0
        let rowGap = style.rowGap?.resolve(width) ?? 0
        let ordered = style.reversed ? boxes.reversed() : boxes
        struct Entry { var box: Box; var basis: CGFloat; var margin: CGFloat; var grow: CGFloat; var shrink: CGFloat }
        let entries = ordered.map { box -> Entry in
            let margin = margins(box, base: width)
            let room = max(0, width - margin.left - margin.right)
            let own = styleOf(box)
            let basis: CGFloat = {
                if let basis = own?.basis, let value = basis.resolve(width) { return value }
                if let value = own?.width?.resolve(width) { return value }
                return preferredWidth(box, available: room)
            }()
            return Entry(box: box, basis: basis, margin: margin.left + margin.right, grow: own?.grow ?? 0, shrink: own?.shrink ?? 1)
        }
        var lines: [[Entry]] = []
        var line: [Entry] = []
        var lineWidth: CGFloat = 0
        for entry in entries {
            let size = entry.basis + entry.margin
            if style.wrap, !line.isEmpty, lineWidth + columnGap + size > width {
                lines.append(line)
                line = []
                lineWidth = 0
            }
            lineWidth += (line.isEmpty ? 0 : columnGap) + size
            line.append(entry)
        }
        if !line.isEmpty { lines.append(line) }
        var placed: [Placed] = []
        var y: CGFloat = 0
        var used: CGFloat = 0
        for (lineIndex, line) in lines.enumerated() {
            if lineIndex > 0 { y += rowGap }
            let gaps = CGFloat(line.count - 1) * columnGap
            let total = line.reduce(0) { $0 + $1.basis + $1.margin } + gaps
            var free = width - total
            var sizes = line.map(\.basis)
            if free > 0 {
                let grow = line.reduce(0) { $0 + $1.grow }
                if grow > 0 {
                    for index in line.indices { sizes[index] += free * line[index].grow / grow }
                    free = 0
                }
            } else if free < 0 {
                let weight = line.reduce(0) { $0 + $1.shrink * $1.basis }
                if weight > 0 {
                    for index in line.indices { sizes[index] = max(0, sizes[index] + free * line[index].shrink * line[index].basis / weight) }
                }
                free = 0
            }
            let laid = line.indices.map { layout(line[$0].box, width: sizes[$0]) }
            let lineHeight = line.indices.map { laid[$0].height + margins(line[$0].box, base: width).top + margins(line[$0].box, base: width).bottom }.max() ?? 0
            // Each box's own width counts toward what's left over.
            free = width - gaps - line.indices.reduce(0) { $0 + laid[$1].width + line[$1].margin }
            var x: CGFloat = 0
            var spacing = columnGap
            switch style.justifyContent {
            case "center": x = max(0, free / 2)
            case "end", "flex-end", "right": x = max(0, free)
            case "space-between": if line.count > 1, free > 0 { spacing += free / CGFloat(line.count - 1) }
            case "space-around": if free > 0 { x = free / CGFloat(line.count) / 2; spacing += free / CGFloat(line.count) }
            case "space-evenly": if free > 0 { x = free / CGFloat(line.count + 1); spacing += free / CGFloat(line.count + 1) }
            default: break
            }
            for index in line.indices {
                let margin = margins(line[index].box, base: width)
                let box = laid[index]
                let align = alignment(self: styleOf(line[index].box)?.alignSelf, items: style.alignItems)
                let top = y + margin.top + offset(align, free: lineHeight - margin.top - margin.bottom - box.height)
                placed += box.offset(x + margin.left, top)
                x += margin.left + box.width + margin.right + spacing
            }
            used = max(used, x - spacing)
            y += lineHeight
        }
        return Laid(width: min(width, used), height: y, placed: placed)
    }

    /// The column tracks' widths at `width`, `count` boxes to place.
    static func tracks(_ template: [String]?, width: CGFloat, gap: CGFloat, count: Int) -> [CGFloat] {
        guard let template, !template.isEmpty else { return [width] }
        func track(_ text: String) -> Track {
            if text.hasSuffix("fr"), let share = Double(text.dropLast(2)) { return .fr(CGFloat(share)) }
            if text.hasPrefix("minmax("), text.hasSuffix(")") {
                let args = text.dropFirst(7).dropLast().components(separatedBy: ", ")
                if args.count == 2 { return .minmax(Length.parse(args[0]) ?? .px(0), track(args[1])) }
            }
            if text.hasPrefix("fit-content("), text.hasSuffix(")") { return .minmax(.px(0), .length(Length.parse(String(text.dropFirst(12).dropLast())) ?? .auto)) }
            if let length = Length.parse(text), length != .auto { return .length(length) }
            return .auto
        }
        func minimum(_ track: Track) -> CGFloat {
            switch track {
            case .length(let length): length.resolve(width) ?? 0
            case .minmax(let min, _): min.resolve(width) ?? 0
            case .fr, .auto: 0
            }
        }
        var list: [Track] = []
        for token in template {
            guard token.hasPrefix("repeat("), token.hasSuffix(")") else { list.append(track(token)); continue }
            let inner = String(token.dropFirst(7).dropLast())
            guard let comma = inner.firstIndex(of: ",") else { continue }
            let times = String(inner[..<comma])
            let repeated = Style.tokens(String(inner[inner.index(after: comma)...]).trimmingCharacters(in: .whitespaces)).map(track)
            var repeats = Int(times) ?? 1
            if times == "auto-fill" || times == "auto-fit" {
                let span = repeated.reduce(0) { $0 + max(1, minimum($1)) } + CGFloat(repeated.count - 1) * gap
                repeats = max(1, Int(((width + gap) / (span + gap)).rounded(.down)))
                // `auto-fit` folds away the tracks nothing fills.
                if times == "auto-fit" { repeats = max(1, min(repeats, Int((Double(count) / Double(max(1, repeated.count))).rounded(.up)))) }
            }
            for _ in 0..<min(24, repeats) { list += repeated }
        }
        list = Array(list.prefix(24))
        let free = width - CGFloat(max(0, list.count - 1)) * gap
        var sizes = list.map { track -> CGFloat? in
            if case .length(let length) = track { return length.resolve(width) }
            return nil
        }
        func share(_ track: Track) -> CGFloat {
            switch track {
            case .fr(let value): value
            case .minmax(_, let max): share(max)
            case .auto: 1
            case .length: 0
            }
        }
        // Shares take what fixed tracks leave; one below its minimum keeps that.
        var flexible = list.indices.filter { sizes[$0] == nil }
        for _ in 0..<3 {
            let fixed = sizes.compactMap { $0 }.reduce(0, +)
            let left = max(0, free - fixed)
            let shares = flexible.reduce(0) { $0 + share(list[$1]) }
            var settled = false
            for index in flexible {
                let size = shares > 0 ? left * share(list[index]) / shares : 0
                if size < minimum(list[index]) { sizes[index] = minimum(list[index]); settled = true }
            }
            flexible = flexible.filter { sizes[$0] == nil }
            if !settled {
                for index in flexible { sizes[index] = shares > 0 ? left * share(list[index]) / shares : 0 }
                break
            }
        }
        return sizes.map { $0 ?? 0 }
    }

    /// A grid: boxes placed in order, row by row, each in the columns it
    /// spans; a row as tall as its tallest cell.
    static func grid(_ style: Style, _ boxes: [Box], width: CGFloat) -> Laid {
        let columnGap = style.columnGap?.resolve(width) ?? 0
        let rowGap = style.rowGap?.resolve(width) ?? 0
        let columns = tracks(style.columns, width: width, gap: columnGap, count: boxes.count)
        let count = max(1, columns.count)
        var cells: [(box: Box, row: Int, column: Int, span: Int)] = []
        var row = 0
        var column = 0
        for box in boxes {
            let own = styleOf(box)
            let span = min(count, own?.columnSpan ?? 1)
            if let start = own?.columnStart.map({ min($0, count - span) }) {
                if start < column { row += 1 }
                column = start
            } else if column + span > count {
                row += 1
                column = 0
            }
            cells.append((box, row, column, span))
            column += span
            if column >= count { row += 1; column = 0 }
        }
        let rows = (cells.map(\.row).max() ?? -1) + 1
        var heights = Array(repeating: CGFloat(0), count: rows)
        var laid: [Laid] = []
        for cell in cells {
            let cellWidth = columns[cell.column..<(cell.column + cell.span)].reduce(0, +) + CGFloat(cell.span - 1) * columnGap
            let margin = margins(cell.box, base: width)
            let room = max(0, cellWidth - margin.left - margin.right)
            let justify = alignment(self: styleOf(cell.box)?.justifySelf, items: style.justifyItems)
            let box = layout(cell.box, width: room, fill: justify == "stretch")
            laid.append(box)
            heights[cell.row] = max(heights[cell.row], box.height + margin.top + margin.bottom)
        }
        if let fixed = style.autoRows?.resolve(0) { heights = heights.map { _ in fixed } }
        var placed: [Placed] = []
        var used: CGFloat = 0
        for (index, cell) in cells.enumerated() {
            let x0 = columns[..<cell.column].reduce(0, +) + CGFloat(cell.column) * columnGap
            let cellWidth = columns[cell.column..<(cell.column + cell.span)].reduce(0, +) + CGFloat(cell.span - 1) * columnGap
            let y0 = heights[..<cell.row].reduce(0, +) + CGFloat(cell.row) * rowGap
            let margin = margins(cell.box, base: width)
            let box = laid[index]
            let justify = alignment(self: styleOf(cell.box)?.justifySelf, items: style.justifyItems)
            let align = alignment(self: styleOf(cell.box)?.alignSelf, items: style.alignItems)
            let x = x0 + margin.left + offset(justify, free: cellWidth - margin.left - margin.right - box.width)
            let y = y0 + margin.top + offset(align, free: heights[cell.row] - margin.top - margin.bottom - box.height)
            placed += box.offset(x, y).filter { $0.frame.minY < y0 + heights[cell.row] }
            used = max(used, x0 + cellWidth)
        }
        let height = heights.reduce(0, +) + CGFloat(max(0, rows - 1)) * rowGap
        return Laid(width: min(width, max(used, columns.reduce(0, +) + CGFloat(count - 1) * columnGap)), height: height, placed: placed)
    }
}
