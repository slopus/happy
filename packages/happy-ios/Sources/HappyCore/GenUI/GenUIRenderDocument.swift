import Foundation
import HappyWire

/// A Gen UI render document (task_375 `genui/RENDER.md`): what the daemon
/// compiles an authoring document into, a flat map of keyed elements built
/// from 15 primitives. Clients draw only these; it carries no dimensions.
///
/// Reading never fails past the bytes: `parse` takes any JSON object, and
/// `tree()` applies the never-fail rules. An unknown primitive drops its
/// subtree, an unknown prop or enum value reads as its default, an element
/// missing a required prop is dropped, and a document with nothing left to
/// draw has no tree, so the client shows `fallback` as text.
public struct GenUIRenderDocument: Equatable, Sendable {
    public static let maxElements = 4000
    /// Where a `gen_ui` artifact version keeps the document its daemon
    /// compiled (`GEN_UI_RENDER_PATH`), beside the files it names.
    public static let path = ".genui/render.json"

    public var version: Int?
    public var compiler: String?
    /// Plain text for when nothing can be drawn.
    public var fallback: String
    public var root: String?
    public var viewers: [String: [GenUIViewerItem]]
    /// The elements as they arrived, read on demand by `tree()`.
    public var elements: [String: JSONValue]

    public init(version: Int? = 1, compiler: String? = nil, fallback: String, root: String?, viewers: [String: [GenUIViewerItem]] = [:], elements: [String: JSONValue]) {
        self.version = version
        self.compiler = compiler
        self.fallback = fallback
        self.root = root
        self.viewers = viewers
        self.elements = elements
    }

    public static func parse(_ data: Data) -> GenUIRenderDocument? {
        guard let json = try? JSONDecoder().decode(JSONValue.self, from: data) else { return nil }
        return parse(json)
    }

    public static func parse(_ json: JSONValue) -> GenUIRenderDocument? {
        guard case .object = json else { return nil }
        var viewers: [String: [GenUIViewerItem]] = [:]
        for (group, items) in json["viewers"]?.objectValue ?? [:] {
            viewers[group] = (items.arrayValue ?? []).compactMap(GenUIViewerItem.parse)
        }
        return GenUIRenderDocument(
            version: json["genuiRender"]?.numberValue.map { Int($0) },
            compiler: json["compiler"]?.stringValue,
            fallback: json["fallback"]?.stringValue ?? "",
            root: json["root"]?.stringValue,
            viewers: viewers,
            elements: json["elements"]?.objectValue ?? [:]
        )
    }

    /// The drawable tree from `root`, or nil when nothing can be drawn: no
    /// root, a root that is dropped, or a render version this client
    /// doesn't read.
    public func tree() -> GenUINode? {
        if let version, version != 1 { return nil }
        guard let root else { return nil }
        var reader = Reader(elements: elements)
        return reader.node(root, depth: 0)
    }

    private struct Reader {
        let elements: [String: JSONValue]
        /// Keys already placed: an element has one parent, and a key that
        /// comes back (a cycle or a second parent) is drawn once.
        var placed: Set<String> = []
        static let maxDepth = 64

        init(elements: [String: JSONValue]) {
            self.elements = elements
        }

        mutating func node(_ key: String, depth: Int) -> GenUINode? {
            guard depth < Self.maxDepth, placed.count < GenUIRenderDocument.maxElements, !placed.contains(key),
                  let element = elements[key], let type = element["type"]?.stringValue else { return nil }
            placed.insert(key)
            let props = element["props"] ?? .object([:])
            let kind: GenUINode.Kind?
            switch type {
            case "box": kind = .box(GenUIBox(props), children(element, depth))
            case "grid": kind = GenUIGrid(props).map { .grid($0, children(element, depth)) }
            case "scroll": kind = .scroll(GenUIShape(props["shape"]), children(element, depth))
            case "switch":
                let compact = slot(element, "compact", depth)
                let regular = slot(element, "regular", depth)
                kind = compact == nil && regular == nil ? nil : .switcher(compact: compact, regular: regular)
            case "press":
                // Without a valid action its content is drawn, untappable.
                kind = .press(GenUIPress(action: GenUIAction(props["action"]), role: GenUIPress.Role(props["role"]) ?? .plain, group: props["group"]?.stringValue), children(element, depth))
            case "text": kind = GenUIText(props).map(GenUINode.Kind.text)
            case "icon": kind = GenUIIcon(props).map(GenUINode.Kind.icon)
            case "image": kind = GenUIImage(props).map(GenUINode.Kind.image)
            case "pill": kind = GenUIPill(props).map(GenUINode.Kind.pill)
            case "button": kind = GenUIButton(props).map(GenUINode.Kind.button)
            case "bar": kind = props["value"]?.numberValue.map { .bar(GenUIBar(value: $0, tone: GenUITone(props["tone"]) ?? .neutral)) }
            case "marker": kind = .marker(GenUIMarker(status: GenUIMarker.Status(props["status"]), rail: props["rail"]?.boolValue ?? false))
            case "spark": kind = GenUISpark(props).map(GenUINode.Kind.spark)
            case "plot": kind = GenUIPlot(props).map(GenUINode.Kind.plot)
            case "code": kind = props["text"]?.stringValue.map { .code(GenUICode(text: $0, language: props["language"]?.stringValue, title: props["title"]?.stringValue)) }
            default: kind = nil
            }
            return kind.map { GenUINode(key: key, kind: $0) }
        }

        private mutating func children(_ element: JSONValue, _ depth: Int) -> [GenUINode] {
            (element["children"]?.arrayValue ?? []).compactMap { $0.stringValue.flatMap { node($0, depth: depth + 1) } }
        }

        private mutating func slot(_ element: JSONValue, _ name: String, _ depth: Int) -> GenUINode? {
            (element["slots"]?[name]?.arrayValue ?? []).lazy.compactMap { $0.stringValue }.first.flatMap { node($0, depth: depth + 1) }
        }
    }
}

/// An image in a document's `viewers` group, for the host's image viewer.
public struct GenUIViewerItem: Equatable, Sendable {
    public var file: String
    public var width: Double
    public var height: Double
    public var thumbhash: String
    public var alt: String
    public var caption: String?

    static func parse(_ json: JSONValue) -> GenUIViewerItem? {
        guard let file = json["file"]?.stringValue else { return nil }
        return GenUIViewerItem(
            file: file, width: json["width"]?.numberValue ?? 0, height: json["height"]?.numberValue ?? 0,
            thumbhash: json["thumbhash"]?.stringValue ?? "", alt: json["alt"]?.stringValue ?? "", caption: json["caption"]?.stringValue
        )
    }
}

/// One element of the drawable tree, with the key the document gave it.
public struct GenUINode: Equatable, Sendable {
    public var key: String
    public var kind: Kind

    public init(key: String, kind: Kind) {
        self.key = key
        self.kind = kind
    }

    public indirect enum Kind: Equatable, Sendable {
        case box(GenUIBox, [GenUINode])
        case grid(GenUIGrid, [GenUINode])
        case scroll(GenUIShape, [GenUINode])
        case switcher(compact: GenUINode?, regular: GenUINode?)
        case press(GenUIPress, [GenUINode])
        case text(GenUIText)
        case icon(GenUIIcon)
        case image(GenUIImage)
        case pill(GenUIPill)
        case button(GenUIButton)
        case bar(GenUIBar)
        case marker(GenUIMarker)
        case spark(GenUISpark)
        case plot(GenUIPlot)
        case code(GenUICode)
    }
}

// MARK: - Enums

/// An enum prop: a known value, or nil for a missing or unknown one, which
/// the caller turns into its default.
protocol GenUIEnum: RawRepresentable where RawValue == String {}

extension GenUIEnum {
    init?(_ json: JSONValue?) {
        guard let value = json?.stringValue.flatMap(Self.init(rawValue:)) else { return nil }
        self = value
    }
}

/// A colour by name: a semantic tone, `muted`, or one of the theme's raw
/// colours (`red`, `brown`, ...). The renderer looks the name up in the
/// shared theme, tones first; a name it doesn't know draws as `neutral`.
public struct GenUITone: Hashable, Sendable {
    public var name: String

    public init(name: String) {
        self.name = name
    }

    init?(_ json: JSONValue?) {
        guard let name = json?.stringValue, !name.isEmpty else { return nil }
        self.init(name: name)
    }

    public static let neutral = GenUITone(name: "neutral")
    public static let accent = GenUITone(name: "accent")
    public static let success = GenUITone(name: "success")
    public static let warning = GenUITone(name: "warning")
    public static let danger = GenUITone(name: "danger")
    public static let muted = GenUITone(name: "muted")
}

public enum GenUIShape: String, Equatable, Sendable {
    case landscape, square, portrait

    init(_ json: JSONValue?) {
        self = json?.stringValue.flatMap(Self.init(rawValue:)) ?? .landscape
    }
}

// MARK: - Actions

/// What activating an element asks the host to do. The renderer reports it
/// with the element's key; the host decides.
public enum GenUIAction: Equatable, Sendable {
    /// Send `text` as the person's next message.
    case message(String)
    case open(String)
    case copy(String)
    case tool(name: String, input: JSONValue)

    init?(_ json: JSONValue?) {
        guard let json, let type = json["type"]?.stringValue else { return nil }
        switch type {
        case "message": guard let text = json["text"]?.stringValue else { return nil }; self = .message(text)
        case "open": guard let url = json["url"]?.stringValue else { return nil }; self = .open(url)
        case "copy": guard let text = json["text"]?.stringValue else { return nil }; self = .copy(text)
        case "tool": guard let name = json["name"]?.stringValue else { return nil }; self = .tool(name: name, input: json["input"] ?? .object([:]))
        default: return nil
        }
    }
}

// MARK: - Containers

public struct GenUIBox: Equatable, Sendable {
    public enum Direction: String, Equatable, Sendable, GenUIEnum { case column, row }
    public enum Role: String, Equatable, Sendable, GenUIEnum { case plain, card, header, actions, notice, section, item, record, tile, mosaic }
    public enum Gap: String, Equatable, Sendable, GenUIEnum { case none, inline, tight, related, labeled, heading, items, blocks }
    public enum Align: String, Equatable, Sendable, GenUIEnum { case start, center, end, baseline, stretch }
    public enum Justify: String, Equatable, Sendable, GenUIEnum { case start, between, end }
    public enum Divide: String, Equatable, Sendable, GenUIEnum { case none, full, inset }
    public enum Leading: String, Equatable, Sendable, GenUIEnum { case none, icon, thumb, number }

    public var direction: Direction
    public var role: Role
    public var gap: Gap
    public var tone: GenUITone?
    public var align: Align
    public var justify: Justify
    public var equal: Bool
    public var wrap: Bool
    public var divide: Divide
    public var leading: Leading
    public var grow: Bool

    public init(
        direction: Direction = .column, role: Role = .plain, gap: Gap = .none, tone: GenUITone? = nil, align: Align = .stretch,
        justify: Justify = .start, equal: Bool = false, wrap: Bool = false, divide: Divide = .none, leading: Leading = .none, grow: Bool = false
    ) {
        self.direction = direction
        self.role = role
        self.gap = gap
        self.tone = tone
        self.align = align
        self.justify = justify
        self.equal = equal
        self.wrap = wrap
        self.divide = divide
        self.leading = leading
        self.grow = grow
    }

    init(_ props: JSONValue) {
        self.init(
            direction: Direction(props["direction"]) ?? .column, role: Role(props["role"]) ?? .plain, gap: Gap(props["gap"]) ?? .none,
            tone: GenUITone(props["tone"]), align: Align(props["align"]) ?? .stretch, justify: Justify(props["justify"]) ?? .start,
            equal: props["equal"]?.boolValue ?? false, wrap: props["wrap"]?.boolValue ?? false, divide: Divide(props["divide"]) ?? .none,
            leading: Leading(props["leading"]) ?? .none, grow: props["grow"]?.boolValue ?? false
        )
    }
}

public struct GenUIGrid: Equatable, Sendable {
    public struct Column: Equatable, Sendable {
        public enum Width: String, Equatable, Sendable, GenUIEnum { case auto, fill }
        public enum Align: String, Equatable, Sendable, GenUIEnum { case start, end }
        public var width: Width
        public var align: Align

        public init(width: Width, align: Align = .start) {
            self.width = width
            self.align = align
        }
    }

    public enum Density: String, Equatable, Sendable, GenUIEnum { case table, pairs }

    public var columns: [Column]
    public var density: Density
    public var divide: Bool
    public var header: Bool

    public init(columns: [Column], density: Density = .table, divide: Bool = false, header: Bool = false) {
        self.columns = columns
        self.density = density
        self.divide = divide
        self.header = header
    }

    init?(_ props: JSONValue) {
        let columns = (props["columns"]?.arrayValue ?? []).prefix(6).map {
            Column(width: Column.Width($0["width"]) ?? .auto, align: Column.Align($0["align"]) ?? .start)
        }
        guard !columns.isEmpty else { return nil }
        self.init(columns: Array(columns), density: Density(props["density"]) ?? .table, divide: props["divide"]?.boolValue ?? false, header: props["header"]?.boolValue ?? false)
    }
}

public struct GenUIPress: Equatable, Sendable {
    /// What is pressed: a list row and a card take a full-area highlight.
    public enum Role: String, Equatable, Sendable, GenUIEnum { case plain, item, tile }

    /// Nil: the content is drawn but can't be pressed.
    public var action: GenUIAction?
    public var role: Role
    /// A single-choice group shared with buttons and other presses.
    public var group: String?

    public init(action: GenUIAction?, role: Role = .plain, group: String? = nil) {
        self.action = action
        self.role = role
        self.group = group
    }
}

// MARK: - Leaves

public struct GenUISpan: Equatable, Sendable {
    public var text: String
    public var strong: Bool
    public var emphasis: Bool
    public var code: Bool
    public var link: String?

    public init(_ text: String, strong: Bool = false, emphasis: Bool = false, code: Bool = false, link: String? = nil) {
        self.text = text
        self.strong = strong
        self.emphasis = emphasis
        self.code = code
        self.link = link
    }
}

public struct GenUIText: Equatable, Sendable {
    public enum Role: String, Equatable, Sendable, GenUIEnum {
        case title, subtitle, heading, prompt, body, note, label, value, delta, item, detail, trailing, column, rowhead, cell, number, ordinal
    }

    public enum Overflow: String, Equatable, Sendable, GenUIEnum { case wrap, clamp, truncate }
    public enum Align: String, Equatable, Sendable, GenUIEnum { case start, end }

    public var spans: [GenUISpan]
    public var role: Role
    public var tone: GenUITone?
    public var overflow: Overflow
    public var align: Align
    /// In a row: keeps its natural width; its siblings give way.
    public var fixed: Bool

    public init(_ spans: [GenUISpan], role: Role = .body, tone: GenUITone? = nil, overflow: Overflow = .wrap, align: Align = .start, fixed: Bool = false) {
        self.spans = spans
        self.role = role
        self.tone = tone
        self.overflow = overflow
        self.align = align
        self.fixed = fixed
    }

    init?(_ props: JSONValue) {
        let spans = (props["spans"]?.arrayValue ?? []).compactMap { span -> GenUISpan? in
            guard let text = span["text"]?.stringValue else { return nil }
            return GenUISpan(
                text, strong: span["strong"]?.boolValue ?? false, emphasis: span["emphasis"]?.boolValue ?? false,
                code: span["code"]?.boolValue ?? false, link: span["link"]?.stringValue
            )
        }
        guard !spans.isEmpty else { return nil }
        self.init(
            spans, role: Role(props["role"]) ?? .body, tone: GenUITone(props["tone"]),
            overflow: Overflow(props["overflow"]) ?? .wrap, align: Align(props["align"]) ?? .start, fixed: props["fixed"]?.boolValue ?? false
        )
    }

    public var plain: String { spans.map(\.text).joined() }
}

public struct GenUIIcon: Equatable, Sendable {
    public enum Role: String, Equatable, Sendable, GenUIEnum { case leading, inline }

    /// The catalog's name; one this client has no glyph for draws nothing.
    public var name: String
    public var tone: GenUITone
    public var role: Role

    public init(_ name: String, tone: GenUITone = .neutral, role: Role = .leading) {
        self.name = name
        self.tone = tone
        self.role = role
    }

    init?(_ props: JSONValue) {
        guard let name = props["name"]?.stringValue else { return nil }
        self.init(name, tone: GenUITone(props["tone"]) ?? .neutral, role: Role(props["role"]) ?? .leading)
    }
}

public struct GenUIImage: Equatable, Sendable {
    public enum Role: String, Equatable, Sendable, GenUIEnum { case figure, tile, thumb, cover }

    public var file: String
    public var width: Double
    public var height: Double
    public var thumbhash: String
    public var alt: String
    public var shape: GenUIShape
    public var role: Role
    public var overlay: String?
    public var viewer: (group: String, index: Int)?

    public init(file: String, width: Double, height: Double, thumbhash: String, alt: String, shape: GenUIShape, role: Role = .figure, overlay: String? = nil, viewer: (group: String, index: Int)? = nil) {
        self.file = file
        self.width = width
        self.height = height
        self.thumbhash = thumbhash
        self.alt = alt
        self.shape = shape
        self.role = role
        self.overlay = overlay
        self.viewer = viewer
    }

    init?(_ props: JSONValue) {
        guard let file = props["file"]?.stringValue, let width = props["width"]?.numberValue, let height = props["height"]?.numberValue,
              let thumbhash = props["thumbhash"]?.stringValue, let alt = props["alt"]?.stringValue else { return nil }
        var viewer: (String, Int)?
        if let group = props["viewer"]?["group"]?.stringValue, let index = props["viewer"]?["index"]?.numberValue { viewer = (group, Int(index)) }
        self.init(
            file: file, width: width, height: height, thumbhash: thumbhash, alt: alt, shape: GenUIShape(props["shape"]),
            role: Role(props["role"]) ?? .figure, overlay: props["overlay"]?.stringValue, viewer: viewer
        )
    }

    public static func == (a: GenUIImage, b: GenUIImage) -> Bool {
        a.file == b.file && a.width == b.width && a.height == b.height && a.thumbhash == b.thumbhash && a.alt == b.alt
            && a.shape == b.shape && a.role == b.role && a.overlay == b.overlay && a.viewer?.group == b.viewer?.group && a.viewer?.index == b.viewer?.index
    }
}

public struct GenUIPill: Equatable, Sendable {
    public var text: String
    public var tone: GenUITone
    public var icon: String?

    public init(_ text: String, tone: GenUITone = .neutral, icon: String? = nil) {
        self.text = text
        self.tone = tone
        self.icon = icon
    }

    init?(_ props: JSONValue) {
        guard let text = props["text"]?.stringValue else { return nil }
        self.init(text, tone: GenUITone(props["tone"]) ?? .neutral, icon: props["icon"]?.stringValue)
    }
}

public struct GenUIButton: Equatable, Sendable {
    public enum Variant: String, Equatable, Sendable, GenUIEnum { case primary, secondary, plain, chip }

    public var label: String
    public var action: GenUIAction
    public var icon: String?
    public var variant: Variant
    public var tone: GenUITone
    public var group: String?

    public init(_ label: String, action: GenUIAction, icon: String? = nil, variant: Variant = .secondary, tone: GenUITone = .neutral, group: String? = nil) {
        self.label = label
        self.action = action
        self.icon = icon
        self.variant = variant
        self.tone = tone
        self.group = group
    }

    init?(_ props: JSONValue) {
        guard let label = props["label"]?.stringValue, let action = GenUIAction(props["action"]) else { return nil }
        self.init(
            label, action: action, icon: props["icon"]?.stringValue, variant: Variant(props["variant"]) ?? .secondary,
            tone: GenUITone(props["tone"]) ?? .neutral, group: props["group"]?.stringValue
        )
    }
}

public struct GenUIBar: Equatable, Sendable {
    /// 0–1, clamped.
    public var value: Double
    public var tone: GenUITone

    public init(value: Double, tone: GenUITone = .neutral) {
        self.value = value.isFinite ? min(1, max(0, value)) : 0
        self.tone = tone
    }
}

public struct GenUIMarker: Equatable, Sendable {
    public enum Status: String, Equatable, Sendable {
        case done, active, pending, failed

        init(_ json: JSONValue?) {
            self = json?.stringValue.flatMap(Self.init(rawValue:)) ?? .pending
        }
    }

    public var status: Status
    /// Draw the rail down to the next step's marker.
    public var rail: Bool

    public init(status: Status, rail: Bool = false) {
        self.status = status
        self.rail = rail
    }
}

public struct GenUISpark: Equatable, Sendable {
    public var values: [Double]
    public var tone: GenUITone

    public init(_ values: [Double], tone: GenUITone = .neutral) {
        self.values = values
        self.tone = tone
    }

    init?(_ props: JSONValue) {
        let values = (props["values"]?.arrayValue ?? []).compactMap(\.numberValue).filter(\.isFinite).suffix(60)
        guard values.count >= 2 else { return nil }
        self.init(Array(values), tone: GenUITone(props["tone"]) ?? .neutral)
    }
}

public struct GenUIPlot: Equatable, Sendable {
    public enum Kind: String, Equatable, Sendable, GenUIEnum { case line, area, bar, donut }

    /// A palette slot: 1-based into the shared chart palette, the colour of
    /// a series that steps back, or a colour by name (a tone or raw colour).
    public enum Color: Equatable, Sendable {
        case index(Int)
        case muted
        case named(String)

        init(_ json: JSONValue?) {
            switch json?.stringValue {
            case "muted": self = .muted
            case let name?: self = .named(name)
            case nil: self = .index(json?.numberValue.map { Int($0) } ?? 1)
            }
        }
    }

    public struct Axis: Equatable, Sendable {
        public var min: Double
        public var max: Double
        public var ticks: [(value: Double, label: String)]

        public init(min: Double, max: Double, ticks: [(value: Double, label: String)]) {
            self.min = min
            self.max = max
            self.ticks = ticks
        }

        public static func == (a: Axis, b: Axis) -> Bool {
            a.min == b.min && a.max == b.max && a.ticks.map(\.value) == b.ticks.map(\.value) && a.ticks.map(\.label) == b.ticks.map(\.label)
        }

        /// Where `value` sits, 0 at `min` and 1 at `max`.
        public func fraction(_ value: Double) -> Double {
            max > min ? (value - min) / (max - min) : 0
        }
    }

    public struct Series: Equatable, Sendable {
        public var name: String
        /// nil is a gap.
        public var values: [Double?]
        public var labels: [String?]?
        public var color: Color

        public init(name: String, values: [Double?], labels: [String?]? = nil, color: Color) {
            self.name = name
            self.values = values
            self.labels = labels
            self.color = color
        }
    }

    public struct Slice: Equatable, Sendable {
        public var label: String
        public var value: Double
        public var color: Color

        public init(label: String, value: Double, color: Color) {
            self.label = label
            self.value = value
            self.color = color
        }
    }

    public struct LegendRow: Equatable, Sendable {
        public var label: String
        public var color: Color
        public var value: String?
        public var share: String?

        public init(label: String, color: Color, value: String? = nil, share: String? = nil) {
            self.label = label
            self.color = color
            self.value = value
            self.share = share
        }
    }

    public var kind: Kind
    public var x: [String]
    public var y: Axis?
    public var series: [Series]
    public var stacked: Bool
    public var slices: [Slice]
    public var legend: [LegendRow]
    public var center: (value: String, label: String)?
    public var summary: String

    public init(
        kind: Kind, x: [String], y: Axis?, series: [Series], stacked: Bool = false, slices: [Slice] = [], legend: [LegendRow] = [],
        center: (value: String, label: String)? = nil, summary: String
    ) {
        self.kind = kind
        self.x = x
        self.y = y
        self.series = series
        self.stacked = stacked
        self.slices = slices
        self.legend = legend
        self.center = center
        self.summary = summary
    }

    init?(_ props: JSONValue) {
        guard let x = props["x"]?.arrayValue, let summary = props["summary"]?.stringValue else { return nil }
        let series = (props["series"]?.arrayValue ?? []).compactMap { json -> Series? in
            guard let name = json["name"]?.stringValue, let values = json["values"]?.arrayValue else { return nil }
            return Series(
                name: name, values: values.map { $0.numberValue.flatMap { $0.isFinite ? $0 : nil } },
                labels: json["labels"]?.arrayValue?.map(\.stringValue), color: Color(json["color"])
            )
        }
        guard !series.isEmpty else { return nil }
        var axis: Axis?
        if let y = props["y"], let low = y["min"]?.numberValue, let high = y["max"]?.numberValue {
            let ticks = (y["ticks"]?.arrayValue ?? []).compactMap { tick -> (Double, String)? in
                guard let value = tick["value"]?.numberValue, let label = tick["label"]?.stringValue else { return nil }
                return (value, label)
            }
            axis = Axis(min: low, max: high, ticks: ticks)
        }
        var center: (String, String)?
        if let value = props["center"]?["value"]?.stringValue, let label = props["center"]?["label"]?.stringValue { center = (value, label) }
        let kind = Kind(props["kind"]) ?? .line
        // A line, area or bar chart can't be drawn without its axis.
        guard kind == .donut || axis != nil else { return nil }
        self.init(
            kind: kind, x: x.map { $0.stringValue ?? "" }, y: axis, series: series, stacked: props["stacked"]?.boolValue ?? false,
            slices: (props["slices"]?.arrayValue ?? []).compactMap { json in
                guard let label = json["label"]?.stringValue, let value = json["value"]?.numberValue else { return nil }
                return Slice(label: label, value: value, color: Color(json["color"]))
            },
            legend: (props["legend"]?.arrayValue ?? []).compactMap { json in
                guard let label = json["label"]?.stringValue else { return nil }
                return LegendRow(label: label, color: Color(json["color"]), value: json["value"]?.stringValue, share: json["share"]?.stringValue)
            },
            center: center, summary: summary
        )
    }

    public static func == (a: GenUIPlot, b: GenUIPlot) -> Bool {
        a.kind == b.kind && a.x == b.x && a.y == b.y && a.series == b.series && a.stacked == b.stacked && a.slices == b.slices
            && a.legend == b.legend && a.center?.value == b.center?.value && a.center?.label == b.center?.label && a.summary == b.summary
    }
}

public struct GenUICode: Equatable, Sendable {
    public var text: String
    public var language: String?
    public var title: String?

    public init(text: String, language: String? = nil, title: String? = nil) {
        self.text = text
        self.language = language
        self.title = title
    }
}
