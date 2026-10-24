import CoreGraphics
import Foundation

/// Desktop's `mediaLayout.ts`: where pictures shown together go, and how big
/// each one is. Nothing crops: every picture keeps its own shape. A plan is
/// made once from the pictures' shapes alone, then drawn at a measure.
///
/// Two kinds of row: `cells`, equal columns, each picture at its column's
/// width and never past its own point size or the row's height cap; and
/// `justified`, pictures sharing one height and filling the width together.
public enum StemCellMediaFlow {
    /// What the layout knows about one picture before its bytes arrive.
    public struct Image: Equatable, Sendable {
        /// Intrinsic pixel size, when the producer stated it.
        public var width: CGFloat?
        public var height: CGFloat?
        /// Pixels per point: a 2× capture is never drawn past half its pixels.
        public var scale: CGFloat?
        /// The shape the thumbhash's header carries, for a size not stated.
        public var hashedRatio: CGFloat?

        public init(width: CGFloat? = nil, height: CGFloat? = nil, scale: CGFloat? = nil, hashedRatio: CGFloat? = nil) {
            self.width = width
            self.height = height
            self.scale = scale
            self.hashedRatio = hashedRatio
        }
    }

    /// The bounds one surface draws its pictures within.
    public struct Limits: Equatable, Sendable {
        /// A picture on a row of its own, and a one-column grid.
        public var singleMaxHeight: CGFloat
        /// A two-column grid's cells.
        public var cellMaxHeight: CGFloat
        /// A justified row's shared height.
        public var rowMaxHeight: CGFloat
    }

    /// What a tool call presents, at the transcript's full measure.
    public static let tool = Limits(singleMaxHeight: 640, cellMaxHeight: 480, rowMaxHeight: 480)
    /// Photos attached to a message.
    public static let message = Limits(singleMaxHeight: 360, cellMaxHeight: 320, rowMaxHeight: 280)
    /// The most photos a message shows inline.
    public static let messageMax = 4
    /// A message's photos stay a bubble's width, not the transcript's.
    public static let messageMaxWidth: CGFloat = 560

    public static let gap: CGFloat = 8
    /// A recording's play button, a circle in the middle of its tile.
    public static let playSize: CGFloat = 48

    public static func playButton(in tile: CGSize) -> CGRect {
        CGRect(x: ((tile.width - playSize) / 2).rounded(), y: ((tile.height - playSize) / 2).rounded(), width: playSize, height: playSize)
    }

    /// The narrowest a picture is drawn because its height is capped.
    public static let minWidth: CGFloat = 160
    static let extremeWide: CGFloat = 3
    static let extremeNarrow: CGFloat = 0.4
    static let justifiedReferenceWidth: CGFloat = 720
    static let justifiedTargetHeight: CGFloat = 300
    static let justifiedMaxPerRow = 4
    static let fallbackRatio: CGFloat = 4 / 3

    public struct Tile: Equatable, Sendable {
        public var index: Int
        /// Width over height.
        public var ratio: CGFloat
        /// The widest this tile is ever drawn.
        public var maxWidth: CGFloat
    }

    public enum Row: Equatable, Sendable {
        case cells(columns: Int, maxHeight: CGFloat, tiles: [Tile])
        case justified(maxHeight: CGFloat, tiles: [Tile])
    }

    public struct Plan: Equatable, Sendable {
        public var rows: [Row]
    }

    /// A picture's width over height: its stated size, else its thumbhash, else 4:3.
    public static func ratio(_ image: Image) -> CGFloat {
        if let width = image.width, let height = image.height, width > 0, height > 0 { return width / height }
        return image.hashedRatio ?? fallbackRatio
    }

    /// Its pixel size over its density; nil when no size was stated.
    public static func pointSize(_ image: Image) -> CGSize? {
        guard let width = image.width, let height = image.height, width > 0, height > 0 else { return nil }
        let scale = (image.scale ?? 1) > 0 ? image.scale ?? 1 : 1
        return CGSize(width: width / scale, height: height / scale)
    }

    static func cellTile(_ image: Image, index: Int, maxHeight: CGFloat) -> Tile {
        let ratio = ratio(image)
        let native = pointSize(image)?.width ?? .infinity
        return Tile(index: index, ratio: ratio, maxWidth: min(native, max(maxHeight * ratio, minWidth)))
    }

    /// The grid the producer asked for (`columns` > 0), or justified rows.
    public static func plan(_ images: [Image], columns: Int, limits: Limits = tool) -> Plan {
        columns > 0 ? columnsPlan(images, columns: columns, limits: limits) : justifiedPlan(images, limits: limits)
    }

    public static func columnsPlan(_ images: [Image], columns: Int, limits: Limits = tool) -> Plan {
        let maxHeight = columns == 1 ? limits.singleMaxHeight : limits.cellMaxHeight
        var rows: [Row] = []
        var start = 0
        while start < images.count {
            let end = min(images.count, start + columns)
            let tiles = (start..<end).map { cellTile(images[$0], index: $0, maxHeight: maxHeight) }
            rows.append(.cells(columns: columns, maxHeight: maxHeight, tiles: tiles))
            start += columns
        }
        return Plan(rows: rows)
    }

    /// A picture of extreme shape takes a row of its own; the runs between
    /// are cut into the rows whose heights land closest to the target.
    public static func justifiedPlan(_ images: [Image], limits: Limits = tool) -> Plan {
        if images.count == 1 {
            return Plan(rows: [.cells(columns: 1, maxHeight: limits.singleMaxHeight, tiles: [cellTile(images[0], index: 0, maxHeight: limits.singleMaxHeight)])])
        }
        var rows: [Row] = []
        var run: [Int] = []
        func flush() {
            for row in partition(run.map { ratio(images[$0]) }) {
                rows.append(justifiedRow(images, indexes: row.map { run[$0] }, limits: limits))
            }
            run = []
        }
        for (index, image) in images.enumerated() {
            let ratio = ratio(image)
            if ratio <= extremeWide, ratio >= extremeNarrow {
                run.append(index)
                continue
            }
            flush()
            rows.append(.cells(columns: 1, maxHeight: limits.singleMaxHeight, tiles: [cellTile(image, index: index, maxHeight: limits.singleMaxHeight)]))
        }
        flush()
        return Plan(rows: rows)
    }

    static func justifiedRow(_ images: [Image], indexes: [Int], limits: Limits) -> Row {
        var maxHeight = limits.rowMaxHeight
        for index in indexes {
            if let point = pointSize(images[index]) { maxHeight = min(maxHeight, point.height) }
        }
        return .justified(maxHeight: maxHeight, tiles: indexes.map { index in
            let ratio = ratio(images[index])
            return Tile(index: index, ratio: ratio, maxWidth: maxHeight * ratio)
        })
    }

    /// The cut of `ratios`, in order, into rows of at most four that
    /// minimises the summed squared distance of each row's height from the target.
    static func partition(_ ratios: [CGFloat]) -> [[Int]] {
        let count = ratios.count
        guard count > 0 else { return [] }
        var best: [CGFloat] = [0] + Array(repeating: .infinity, count: count)
        var cut = Array(repeating: 0, count: count + 1)
        for end in 1...count {
            var sum: CGFloat = 0
            var start = end - 1
            while start >= max(0, end - justifiedMaxPerRow) {
                sum += ratios[start]
                let size = CGFloat(end - start)
                let height = (justifiedReferenceWidth - (size - 1) * gap) / sum
                let cost = best[start] + (height - justifiedTargetHeight) * (height - justifiedTargetHeight)
                if cost < best[end] {
                    best[end] = cost
                    cut[end] = start
                }
                start -= 1
            }
        }
        var rows: [[Int]] = []
        var end = count
        while end > 0 {
            rows.insert(Array(cut[end]..<end), at: 0)
            end = cut[end]
        }
        return rows
    }

    /// Every tile's box with the plan drawn at `measure`, by index, and the
    /// height it takes. `alignEnd` pushes short rows and cells to the right,
    /// as a person's own photos are.
    public static func geometry(_ plan: Plan, measure: CGFloat, alignEnd: Bool = false) -> (frames: [Int: CGRect], height: CGFloat) {
        var frames: [Int: CGRect] = [:]
        var y: CGFloat = 0
        for (rowIndex, row) in plan.rows.enumerated() {
            if rowIndex > 0 { y += gap }
            var rowHeight: CGFloat = 0
            switch row {
            case .cells(let columns, let maxHeight, let tiles):
                let column = (measure - CGFloat(columns - 1) * gap) / CGFloat(columns)
                // At the end, the row's cells sit against the right edge.
                let shift = alignEnd ? measure - (CGFloat(tiles.count) * (column + gap) - gap) : 0
                for (cell, tile) in tiles.enumerated() {
                    let width = min(column, tile.maxWidth)
                    let height = min(width / tile.ratio, maxHeight)
                    var x = CGFloat(cell) * (column + gap) + shift
                    if alignEnd { x += column - width }
                    frames[tile.index] = CGRect(x: x, y: y, width: width, height: height)
                    rowHeight = max(rowHeight, height)
                }
            case .justified(let maxHeight, let tiles):
                let free = measure - CGFloat(tiles.count - 1) * gap
                let sum = tiles.reduce(0) { $0 + $1.ratio }
                rowHeight = min(free / sum, maxHeight)
                let used = tiles.reduce(0) { $0 + rowHeight * $1.ratio } + CGFloat(tiles.count - 1) * gap
                var x = alignEnd ? measure - used : 0
                for tile in tiles {
                    let width = rowHeight * tile.ratio
                    frames[tile.index] = CGRect(x: x, y: y, width: width, height: rowHeight)
                    x += width + gap
                }
            }
            y += rowHeight
        }
        return (frames, y)
    }

    /// The box a recording is drawn in, from its intrinsic size alone:
    /// scaled down into 380 × 320, never up; 380 × 214 when none was stated.
    public static func videoBox(width: CGFloat?, height: CGFloat?) -> CGSize {
        guard let width, let height, width > 0, height > 0 else { return CGSize(width: 380, height: 214) }
        let ratio = width / height
        let boxWidth = min(width, 380)
        let boxHeight = boxWidth / ratio
        if boxHeight <= 320 { return CGSize(width: boxWidth.rounded(), height: boxHeight.rounded()) }
        return CGSize(width: min(max(320 * ratio, 240), boxWidth).rounded(), height: 320)
    }
}

/// One tool call's pictures and recordings, as desktop's ConversationMedia
/// draws them: every picture first, together, as one flow; then each
/// recording at its own box, no wider than the measure.
public struct StemCellMediaLayout: Equatable, Sendable {
    public struct Item: Equatable, Sendable {
        public var isVideo: Bool
        public var image: StemCellMediaFlow.Image

        public init(isVideo: Bool, image: StemCellMediaFlow.Image) {
            self.isVideo = isVideo
            self.image = image
        }
    }

    /// One frame per item, in the items' order.
    public var frames: [CGRect]
    public var size: CGSize

    /// `columns` 0 lets the pictures fall into justified rows.
    public init(width: CGFloat, items: [Item], columns: Int, limits: StemCellMediaFlow.Limits = StemCellMediaFlow.tool, alignEnd: Bool = false) {
        let gap = StemCellMediaFlow.gap
        var frames = Array(repeating: CGRect.zero, count: items.count)
        let pictures = items.indices.filter { !items[$0].isVideo }
        var y: CGFloat = 0
        if !pictures.isEmpty {
            let plan = StemCellMediaFlow.plan(pictures.map { items[$0].image }, columns: columns, limits: limits)
            let flow = StemCellMediaFlow.geometry(plan, measure: width, alignEnd: alignEnd)
            for (position, index) in pictures.enumerated() { frames[index] = flow.frames[position] ?? .zero }
            y = flow.height
        }
        for index in items.indices where items[index].isVideo {
            if y > 0 { y += gap }
            var box = StemCellMediaFlow.videoBox(width: items[index].image.width, height: items[index].image.height)
            if box.width > width, box.width > 0 {
                box = CGSize(width: width, height: (box.height * width / box.width).rounded())
            }
            frames[index] = CGRect(x: alignEnd ? width - box.width : 0, y: y, width: box.width, height: box.height)
            y += box.height
        }
        self.frames = frames
        let used = frames.map(\.maxX).max() ?? 0
        size = CGSize(width: alignEnd ? width : used, height: y)
    }
}
