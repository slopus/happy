import Foundation

/// The story editor, as Telegram's story editor lays itself out
/// (`MediaEditorScreen`, `MessageInputPanelComponent`, `DrawingUI`): the
/// 9:16 canvas full width under the status bar with 30pt corners; the
/// caption field over the canvas's foot; under the canvas the back button
/// at the left, the tools in one pill between, and Post at the right; the
/// frames button over the caption at the right, opening the frames panel
/// above it. A phone too short for the canvas and its bar (home-button
/// phones) starts the canvas at the top and lifts the bar 62pt above the
/// home indicator, over the canvas. An iPad fits the canvas to the height.
public struct StoryEditorLayout: Equatable, Sendable {
    public enum Metrics {
        public static let aspect: CGFloat = 1.77778
        public static let canvasTop: CGFloat = 5
        public static let cornerRadius: CGFloat = 30
        public static let button: CGFloat = 44
        public static let buttonTop: CGFloat = 8
        public static let side: CGFloat = 16
        public static let narrowSide: CGFloat = 9
        public static let tabletSide: CGFloat = 30
        public static let tabletBottom: CGFloat = 75
        public static let shortLift: CGFloat = 62
        public static let toolSpacing: CGFloat = 10
        public static let tools = 2
        /// The caption field: 40 tall, 9 in from the canvas's sides, its
        /// panel 6 under it and 3 over the canvas's foot.
        public static let captionHeight: CGFloat = 40
        public static let captionSide: CGFloat = 9
        public static let captionPanelTop: CGFloat = 14
        public static let captionPanelBottom: CGFloat = 6
        public static let captionLift: CGFloat = 3
        /// Post's pill (`GlassBarButtonComponent`): its label and arrow 12.5 in from its ends.
        public static let postPadding: CGFloat = 12.5
        public static let frames: CGFloat = 33
        public static let framesSide: CGFloat = 12
        public static let panelHeight: CGFloat = 120
        public static let panelGap: CGFloat = 10
        public static let panelItem = CGSize(width: 95, height: 112)
        public static let panelSpacing: CGFloat = 4
        /// The bin, in canvas units of a 1080-wide canvas: 180 square, 20 over the foot.
        public static let bin: CGFloat = 180
        public static let binBottom: CGFloat = 20
        public static let binCircle: CGFloat = 160
    }

    public var canvas: CGRect
    public var close: CGRect
    /// The tools' pill, and in it text and stickers, left to right.
    public var tools: CGRect
    public var toolButtons: [CGRect]
    public var post: CGRect
    /// The caption's panel and the field in it.
    public var captionPanel: CGRect
    public var caption: CGRect
    public var framesButton: CGRect
    /// The bin's square and its circle, over the canvas's foot.
    public var bin: CGRect
    public var binCircle: CGRect

    /// `statusBar` is the status bar's height, `homeIndicator` the safe
    /// area's bottom, and `postContent` Post's label and arrow measured.
    public init(bounds: CGRect, statusBar: CGFloat, homeIndicator: CGFloat, postContent: CGFloat, tablet: Bool = false) {
        typealias M = Metrics
        var top = statusBar + M.canvasTop
        var size: CGSize
        var lift: CGFloat = 0
        let side: CGFloat
        if tablet {
            let height = bounds.height - top - M.tabletBottom
            size = CGSize(width: (height / M.aspect).rounded(.down), height: height)
            side = M.tabletSide
        } else {
            size = CGSize(width: bounds.width, height: (bounds.width * M.aspect).rounded(.down))
            if bounds.height < size.height + 30 {
                top = 0
                lift = -M.shortLift - homeIndicator
                side = M.narrowSide
            } else {
                side = bounds.width > 320 ? M.side : M.narrowSide
            }
        }
        canvas = CGRect(x: bounds.minX + ((bounds.width - size.width) / 2).rounded(.down), y: bounds.minY + top, width: size.width, height: size.height)
        // Telegram's safe bottom is the space under the canvas.
        let safeBottom = max(0, bounds.height - size.height - top)
        let row = bounds.maxY - safeBottom + M.buttonTop + lift
        close = CGRect(x: bounds.minX + side, y: row, width: M.button, height: M.button)
        let postWidth = ceil(postContent + 2 * M.postPadding)
        post = CGRect(x: bounds.maxX - side - postWidth, y: row, width: postWidth, height: M.button)
        let toolsWidth = M.button * CGFloat(M.tools) + M.toolSpacing * CGFloat(M.tools - 1)
        tools = CGRect(x: close.maxX + ((post.minX - close.maxX - toolsWidth) / 2).rounded(.down), y: row, width: toolsWidth, height: M.button)
        toolButtons = (0..<M.tools).map { CGRect(x: CGFloat($0) * (M.button + M.toolSpacing), y: 0, width: M.button, height: M.button) }
        let panelHeight = M.captionPanelTop + M.captionHeight + M.captionPanelBottom
        captionPanel = CGRect(x: canvas.minX, y: bounds.maxY - safeBottom + lift - M.captionLift - panelHeight, width: canvas.width, height: panelHeight)
        caption = CGRect(x: captionPanel.minX + M.captionSide, y: captionPanel.minY + M.captionPanelTop, width: max(0, captionPanel.width - 2 * M.captionSide), height: M.captionHeight)
        framesButton = CGRect(x: bounds.maxX - M.frames - M.framesSide, y: captionPanel.minY - M.frames, width: M.frames, height: M.frames)
        let unit = canvas.width / 1080
        bin = CGRect(x: canvas.minX + (canvas.width - M.bin * unit) / 2, y: canvas.maxY - (M.bin + M.binBottom) * unit, width: M.bin * unit, height: M.bin * unit)
        binCircle = bin.insetBy(dx: (M.bin - M.binCircle) / 2 * unit, dy: (M.bin - M.binCircle) / 2 * unit)
    }

    /// The frames panel over the frames button, and in it each frame's
    /// card and the add card after them.
    public struct Panel: Equatable, Sendable {
        public var frame: CGRect
        public var items: [CGRect]
        public var add: CGRect?
        public var content: CGSize
    }

    public func panel(width: CGFloat, frames: Int, canAdd: Bool) -> Panel {
        typealias M = Metrics
        let count = frames + (canAdd ? 1 : 0)
        var x = M.panelSpacing
        var items: [CGRect] = []
        for _ in 0..<count {
            items.append(CGRect(x: x, y: M.panelSpacing, width: M.panelItem.width, height: M.panelItem.height))
            x += M.panelItem.width + M.panelSpacing
        }
        let content = CGSize(width: x, height: M.panelItem.height + 2 * M.panelSpacing)
        let available = width - 2 * M.framesSide
        let frame = CGRect(x: framesButton.maxX - min(available, content.width), y: framesButton.minY - M.panelGap - M.panelHeight, width: min(available, content.width), height: M.panelHeight)
        let add = canAdd ? items.popLast() : nil
        return Panel(frame: frame, items: items, add: add, content: content)
    }
}

/// Telegram's interactive stickers over the sticker grid (`StoryStickersContentView`):
/// pills 34 tall and a reaction bubble 52 across, in rows 18 in from the
/// sides and 12 apart, spread up to 30 apart and centred.
public struct StoryStickerPillsLayout: Equatable, Sendable {
    public enum Metrics {
        public static let padding: CGFloat = 18
        public static let minSpacing: CGFloat = 8
        public static let maxSpacing: CGFloat = 30
        public static let rowSpacing: CGFloat = 12
        public static let pillHeight: CGFloat = 34
        public static let pillPadding: CGFloat = 7
        public static let pillIcon: CGFloat = 20
        public static let pillGap: CGFloat = 4
        public static let reaction: CGFloat = 52
    }

    public var items: [CGRect]
    public var height: CGFloat

    /// The pill a title of `width` makes.
    public static func pill(title width: CGFloat) -> CGSize {
        typealias M = Metrics
        return CGSize(width: M.pillPadding + M.pillIcon + M.pillGap + ceil(width) + M.pillPadding, height: M.pillHeight)
    }

    public init(width: CGFloat, sizes: [CGSize]) {
        typealias M = Metrics
        var rows: [[Int]] = []
        var row: [Int] = []
        for index in sizes.indices {
            let used = (row + [index]).reduce(0) { $0 + sizes[$1].width }
            let spacing = row.isEmpty ? .greatestFiniteMagnitude : (width - used - 2 * M.padding) / CGFloat(row.count)
            if !row.isEmpty, spacing < M.minSpacing {
                rows.append(row)
                row = []
            }
            row.append(index)
        }
        if !row.isEmpty { rows.append(row) }
        var y = M.padding
        var items = [CGRect](repeating: .zero, count: sizes.count)
        for (number, row) in rows.enumerated() {
            let used = row.reduce(0) { $0 + sizes[$1].width }
            let height = row.map { sizes[$0].height }.max() ?? 0
            var spacing = row.count > 1 ? (width - used - 2 * M.padding) / CGFloat(row.count - 1) : M.maxSpacing
            var x = M.padding
            if spacing > M.maxSpacing || row.count == 1 {
                spacing = M.maxSpacing
                x = ((width - used - spacing * CGFloat(row.count - 1)) / 2).rounded(.down)
            }
            for index in row {
                let size = sizes[index]
                items[index] = CGRect(x: x, y: y + ((height - size.height) / 2).rounded(.down), width: size.width, height: size.height)
                x += size.width + spacing
            }
            y += height + (number == rows.count - 1 ? 0 : M.rowSpacing)
        }
        self.items = items
        height = y + M.padding - M.rowSpacing
    }
}

/// The sticker picker's scroll, as Telegram's sticker panel: sections one
/// under another, each a centred uppercase header over a grid of square
/// cells (`StickerGrid` columns), the stickers fitted inside them.
public struct StickerPickerLayout: Equatable, Sendable {
    public enum Metrics {
        public static let inset: CGFloat = 8
        public static let spacing: CGFloat = 4
        public static let header: CGFloat = 32
        public static let sectionGap: CGFloat = 8
        /// Room under the last row for the floating switch.
        public static let bottom: CGFloat = 72
        public static let clear: CGFloat = 32
    }

    public struct Section: Equatable, Sendable {
        public var kind: StickerPackKindLayout
        public var count: Int
        public var header: Bool
        public init(kind: StickerPackKindLayout, count: Int, header: Bool = true) {
            self.kind = kind
            self.count = count
            self.header = header
        }
    }

    public struct Placed: Equatable, Sendable {
        public var header: CGRect?
        /// The ✕ in the header (Recently used).
        public var clear: CGRect?
        public var cells: [CGRect]
        public var columns: Int
    }

    public var sections: [Placed]
    public var height: CGFloat

    /// `clears` marks the sections whose header has a ✕.
    public init(width: CGFloat, sections: [Section], clears: Set<Int> = []) {
        typealias M = Metrics
        let grid = max(0, width - 2 * M.inset)
        var y: CGFloat = 0
        var placed: [Placed] = []
        for (index, section) in sections.enumerated() {
            var header: CGRect?
            var clear: CGRect?
            if section.header {
                header = CGRect(x: M.inset, y: y, width: grid, height: M.header)
                if clears.contains(index) { clear = CGRect(x: M.inset + grid - M.clear, y: y, width: M.clear, height: M.header) }
                y += M.header
            }
            let columns = Self.columns(section.kind, width: grid)
            let side = columns > 0 ? ((grid - CGFloat(columns - 1) * M.spacing) / CGFloat(columns)).rounded(.down) : 0
            // Whole-point cells, the rounding left spread at the right.
            var cells: [CGRect] = []
            for item in 0..<section.count {
                let row = item / columns, column = item % columns
                cells.append(CGRect(x: M.inset + CGFloat(column) * (side + M.spacing), y: y + CGFloat(row) * (side + M.spacing), width: side, height: side))
            }
            let rows = (section.count + columns - 1) / columns
            y += rows > 0 ? CGFloat(rows) * side + CGFloat(rows - 1) * M.spacing : 0
            y += M.sectionGap
            placed.append(Placed(header: header, clear: clear, cells: cells, columns: columns))
        }
        self.sections = placed
        height = y + M.bottom
    }

    /// `max(5, ⌊(w + s) / (70 + s)⌋)` for stickers, `max(8, ⌊(w + s) / (40 + s)⌋)` for emoji.
    public static func columns(_ kind: StickerPackKindLayout, width: CGFloat) -> Int {
        let (minimum, cell): (Int, CGFloat) = kind == .stickers ? (5, 70) : (8, 40)
        return max(minimum, Int(((width + Metrics.spacing) / (cell + Metrics.spacing)).rounded(.down)))
    }
}

/// A pack's kind as the layout sizes it (HappyLayout doesn't see HappyCore).
public enum StickerPackKindLayout: Equatable, Sendable {
    case stickers, emoji
}


/// Typing a text overlay, as Telegram's text tool: Cancel and Done over the
/// top, the size slider at the left edge centred between the top and the
/// keyboard, the text typed on the canvas's centre, and on the keyboard's
/// own bar the colour swatch, the fill and the alignment at the left and
/// the font at the right.
public struct StoryTextEntryLayout: Equatable, Sendable {
    public enum Metrics {
        public static let topRow: CGFloat = 10
        public static let topRowSafe: CGFloat = 20
        public static let topButtonHeight: CGFloat = 30
        public static let topSide: CGFloat = 13
        public static let slider = CGSize(width: 30, height: 240)
        public static let knob: CGFloat = 52
        /// The slider's track runs 12 past its ends for the knob.
        public static let sliderOverhang: CGFloat = 12
        /// New text's size on the slider, and the canvas's width it wraps at.
        public static let newSize: CGFloat = 0.08
        public static let newWidth: Double = 0.9
        public static let bar: CGFloat = 44
        public static let swatchCenter: CGFloat = 24
        public static let style: CGFloat = 48
        public static let align: CGFloat = 92
        public static let barButton: CGFloat = 44
        public static let fontSide: CGFloat = 16
        public static let fontHeight: CGFloat = 30
        /// The font pill: its name 10 in, 30 at the right for the chevron.
        public static let fontLeft: CGFloat = 10
        public static let fontRight: CGFloat = 30
    }

    public var cancel: CGRect
    public var done: CGRect
    public var slider: CGRect

    /// `safeTop` and `safeBottom` are the safe area's, and `keyboard` how
    /// far the keyboard (with its bar) reaches up from the bottom.
    public init(bounds: CGRect, statusBar: CGFloat, safeTop: CGFloat, safeBottom: CGFloat, keyboard: CGFloat, cancelWidth: CGFloat, doneWidth: CGFloat) {
        typealias M = Metrics
        let row = bounds.minY + max(statusBar + M.topRow, safeTop + M.topRowSafe)
        cancel = CGRect(x: bounds.minX + M.topSide, y: row, width: ceil(cancelWidth), height: M.topButtonHeight)
        done = CGRect(x: bounds.maxX - M.topSide - ceil(doneWidth), y: row, width: ceil(doneWidth), height: M.topButtonHeight)
        let top = max(safeTop, statusBar)
        let bottom = keyboard > 0 ? keyboard : safeBottom
        slider = CGRect(x: bounds.minX, y: bounds.minY + (top + (bounds.height - top - bottom) / 2 - M.slider.height / 2).rounded(.down), width: M.slider.width, height: M.slider.height)
    }

    /// The knob's centre on a slider of `height` at `value`, and the value
    /// a finger at `y` sets, both in the slider's own coordinates.
    public static func knob(value: CGFloat, height: CGFloat) -> CGFloat {
        let o = Metrics.sliderOverhang
        return -o + (height + 2 * o - Metrics.knob) * (1 - min(1, max(0, value))) + Metrics.knob / 2
    }

    public static func value(y: CGFloat, height: CGFloat) -> CGFloat {
        let o = Metrics.sliderOverhang
        return 1 - min(1, max(0, (y - o) / (height - 2 * o)))
    }

    /// The keyboard bar's controls, on a bar `width` wide.
    public struct Bar: Equatable, Sendable {
        public var swatch: CGRect
        public var style: CGRect
        public var align: CGRect
        public var font: CGRect
    }

    public static func bar(width: CGFloat, fontTitle: CGFloat) -> Bar {
        typealias M = Metrics
        let fontWidth = M.fontLeft + ceil(fontTitle) + M.fontRight
        return Bar(
            swatch: CGRect(x: M.swatchCenter - M.barButton / 2, y: 0, width: M.barButton, height: M.bar),
            style: CGRect(x: M.style, y: 0, width: M.barButton, height: M.bar),
            align: CGRect(x: M.align, y: 0, width: M.barButton, height: M.bar),
            font: CGRect(x: width - M.fontSide - fontWidth, y: (M.bar - M.fontHeight) / 2, width: fontWidth, height: M.fontHeight)
        )
    }

    /// The text's size from the slider, as Telegram maps it: the font from
    /// 2.5% to 25% of the canvas's longer side, which is `scale` 0.71 to
    /// 7.1 of the API's 1/16 of the width.
    public static func scale(slider value: CGFloat) -> CGFloat {
        let font = 0.025 + (0.25 - 0.025) * min(1, max(0, value))
        return font * 1920 / (1080 / 16)
    }

    public static func slider(scale: CGFloat) -> CGFloat {
        let font = scale * (1080 / 16) / 1920
        return min(1, max(0, (font - 0.025) / (0.25 - 0.025)))
    }
}
