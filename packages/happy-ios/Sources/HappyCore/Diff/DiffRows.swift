import Foundation

/// engine/splitRows.ts: unified rows paired into side-by-side rows. The
/// i-th removal of a run sits opposite the i-th addition after it, as the
/// word emphasis pairs them; the shorter side pads with nil.
public enum DiffSplitRow: Equatable, Sendable {
    /// Hunk separators and messages span both columns.
    case full(DiffRow)
    /// `left` is the old side, nil for a pure addition; `right` the new.
    case pair(key: String, left: DiffLine?, right: DiffLine?)

    public var key: String {
        switch self {
        case .full(let row): row.key
        case .pair(let key, _, _): key
        }
    }

    public static func build(_ rows: [DiffRow]) -> [DiffSplitRow] {
        var out: [DiffSplitRow] = []
        var index = 0
        while index < rows.count {
            guard let line = rows[index].line else {
                out.append(.full(rows[index]))
                index += 1
                continue
            }
            if line.type == .ctx {
                // Context exists on both sides.
                out.append(.pair(key: line.key, left: line, right: line))
                index += 1
                continue
            }
            var delEnd = index
            while delEnd < rows.count, rows[delEnd].line?.type == .del { delEnd += 1 }
            var addEnd = delEnd
            while addEnd < rows.count, rows[addEnd].line?.type == .add { addEnd += 1 }
            let dels = rows[index..<delEnd].compactMap(\.line)
            let adds = rows[delEnd..<addEnd].compactMap(\.line)
            for pair in 0..<max(dels.count, adds.count) {
                let left = pair < dels.count ? dels[pair] : nil
                let right = pair < adds.count ? adds[pair] : nil
                out.append(.pair(key: "\(left?.key ?? "_")|\(right?.key ?? "_")", left: left, right: right))
            }
            // Always advances: this row was a `del` or an `add`.
            index = addEnd
        }
        return out
    }
}

/// components/diff/layout.ts `selectVisibleRows`: which rows a file shows
/// before "show more".
public enum DiffRowSelection {
    /// How far past the limit the cut may move to finish a change block.
    public static let maxSnap = 200

    public struct Result: Equatable, Sendable {
        public var rows: [DiffRow]
        /// Rows held back, for the "show more" button.
        public var hiddenCount: Int
    }

    public static func select(_ rows: [DiffRow], showHunkHeaders: Bool, expanded: Bool, collapseAfter: Int) -> Result {
        let visible = showHunkHeaders ? rows : rows.filter { if case .hunk = $0 { false } else { true } }
        if expanded || visible.count <= collapseAfter {
            return Result(rows: visible, hiddenCount: 0)
        }
        var end = collapseAfter
        // Never cut between removals and the additions that replaced them.
        if isChange(visible, end - 1), isChange(visible, end) {
            let limit = min(visible.count, end + maxSnap)
            while end < limit, isChange(visible, end) { end += 1 }
        }
        return Result(rows: Array(visible[..<end]), hiddenCount: visible.count - end)
    }

    private static func isChange(_ rows: [DiffRow], _ index: Int) -> Bool {
        guard rows.indices.contains(index), let line = rows[index].line else { return false }
        return line.type != .ctx
    }
}

/// useProgressiveRows.ts: a long list fills in over a few passes, 120 rows
/// first, then 200 at a time, so the first frame never waits for the whole
/// file. Short lists are complete at once.
public struct DiffProgressiveRows: Equatable, Sendable {
    public static let initial = 120
    public static let chunk = 200

    public private(set) var total: Int
    public private(set) var count: Int
    public let initial: Int
    public let chunk: Int

    public init(total: Int, initial: Int = DiffProgressiveRows.initial, chunk: Int = DiffProgressiveRows.chunk) {
        self.total = total
        self.initial = initial
        self.chunk = chunk
        count = min(total, initial)
    }

    public var isComplete: Bool { count >= total }

    /// The next pass; false once everything is in.
    @discardableResult
    public mutating func advance() -> Bool {
        guard !isComplete else { return false }
        count = min(total, count + chunk)
        return true
    }

    /// A different document starts again at the initial window.
    public mutating func reset(total: Int) {
        self.total = total
        count = min(total, initial)
    }

    /// The same document re-decorated keeps what it has filled.
    public mutating func update(total: Int) {
        self.total = total
        count = min(total, max(count, min(total, initial)))
    }
}
