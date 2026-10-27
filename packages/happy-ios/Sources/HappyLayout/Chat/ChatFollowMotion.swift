import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// How the chat moves while it follows the newest message
/// (`ChatScrollAnchor.Kind.newest`): a message sent or received, a reply
/// streaming in a line at a time, a row that opens or closes there.
///
/// Every follow uses one timing: ease-out (CSS's `ease-out`, control points
/// 0, 0, 0.58, 1) over 0.4 s. It starts at speed and lands softly. That
/// matters because a streamed reply grows a line every 100 to 250 ms, so
/// most follows start while the previous one is still moving. An
/// ease-in-out starts from rest, so the list stopped dead and set off again
/// at every line (14 stalls in nine seconds of the live fixture, measured
/// on an iPhone 12). An ease-out picks up where the last one was heading.
///
/// What moves is one rigid block: the rows that stay, and any rows just
/// added at the newest end, which slide up from under the dock with them
/// instead of fading in over the row moving out of their way.
public enum ChatFollowMotion {
    public static let duration: Double = 0.4
    public static let controlPoints: (x1: Double, y1: Double, x2: Double, y2: Double) = (0, 0, 0.58, 1)

    /// The rows `new` adds at its newest end, newest first: every row of
    /// `new` that `old` lacks, when they all come before every row both
    /// share and the shared rows keep their order. Empty when nothing was
    /// added. Nil when anything else changed membership or order: a row
    /// added further back, a row removed, a row moved. Those keep the
    /// list's ordinary per-row animation.
    public static func newestInserts(old: [String], new: [String]) -> [String]? {
        let kept = Set(old)
        let added = new.prefix { !kept.contains($0) }
        guard Array(new.dropFirst(added.count)) == old else { return nil }
        return Array(added)
    }

    /// How far the rows the reader sees move away from the newest edge
    /// (content y, so up the screen) when `old` becomes `new` at the newest
    /// edge: the far edge of the oldest row on screen that both have.
    /// `visibleHeight` is the list's height between its insets. Nil when no
    /// row on screen survives.
    public static func shift(from old: ChatListLayout, ids oldIds: [String], to new: ChatListLayout, ids newIds: [String], visibleHeight: CGFloat) -> CGFloat? {
        guard old.count == oldIds.count, new.count == newIds.count else { return nil }
        let index = Dictionary(newIds.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
        for row in old.rows(from: 0, to: max(visibleHeight, 1)).reversed() {
            guard let next = index[oldIds[row]] else { continue }
            return new.frame(ofRow: next).maxY - old.frame(ofRow: row).maxY
        }
        return nil
    }
}
