import Foundation

/// Keeps the reader on the unchanged part of a list, not on a row that
/// was itself moved. Insertions shift indices without moving existing rows.
public enum SidebarScrollAnchor {
    public static func index(previous: [String], next: [String], boxes: [CGRect], nextBoxes: [CGRect], viewport: CGRect) -> Int? {
        guard previous.count == boxes.count, next.count == nextBoxes.count,
              let first = boxes.firstIndex(where: { $0.intersects(viewport) }) else { return nil }
        if previous == next { return first }
        // The unchanged subsequence excludes removals and the removed half
        // of moves. Comparing absolute indices would reject every row after
        // an insertion, including the very row we need to keep steady.
        let changes = next.difference(from: previous)
        let removed = Set(changes.removals.map { change -> Int in
            guard case .remove(let offset, _, _) = change else { preconditionFailure() }
            return offset
        })
        let visible = boxes.indices.filter { !removed.contains($0) && boxes[$0].intersects(viewport) }
        if let firstVisible = visible.first {
            let nextY = Dictionary(zip(next, nextBoxes.map(\.minY)), uniquingKeysWith: { first, _ in first })
            let reordered = removed.contains { nextY[previous[$0]] != nil }
            guard reordered else { return firstVisible }
            // An adjacent swap has two equally valid edit scripts. Keeping
            // either swapped row can still drag all the other visible rows.
            // Keep the middle displacement of the unchanged visible group;
            // a single crossing row cannot pull that group along with it.
            let deltas = visible.compactMap { index in nextY[previous[index]].map { (index: index, y: $0 - boxes[index].minY) } }
            let middle = deltas.map(\.y).sorted()[deltas.count / 2]
            return deltas.first { $0.y == middle }?.index
        }
        // A whole visible group may disappear (a fold/archive). Prefer its
        // following neighbor, then the preceding one if the tail vanished.
        if let following = boxes.indices.first(where: { $0 > first && !removed.contains($0) }) { return following }
        return boxes.indices.last(where: { $0 < first && !removed.contains($0) })
    }
}