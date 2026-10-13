import Foundation

/// What one list update does to its rows, worked out off the main thread by
/// comparing the rows the list applied last with the next ones. The main
/// thread hands it to the table or collection view as is.
///
/// Indexes follow UIKit's batch-update rules: `deletes` and `moves.from`
/// count in the old rows, `inserts`, `moves.to` and `reconfigures` in the
/// new ones. A row whose id stayed but whose value changed is reconfigured
/// in place, never deleted and inserted again; a row that also moved is in
/// both `moves` and `reconfigures`.
public struct RowChangeset: Equatable, Sendable {
    public struct Move: Equatable, Sendable {
        public var from: Int
        public var to: Int

        public init(from: Int, to: Int) {
            self.from = from
            self.to = to
        }
    }

    public var deletes: [Int]
    public var inserts: [Int]
    public var moves: [Move]
    public var reconfigures: [Int]

    public init(deletes: [Int] = [], inserts: [Int] = [], moves: [Move] = [], reconfigures: [Int] = []) {
        self.deletes = deletes
        self.inserts = inserts
        self.moves = moves
        self.reconfigures = reconfigures
    }

    /// `old` and `new` are the rows in order; `id` names a row across the
    /// two. Ids are expected to be unique within each side.
    public init<Row: Equatable, ID: Hashable>(from old: [Row], to new: [Row], id: (Row) -> ID) {
        let oldIds = old.map(id)
        let newIds = new.map(id)
        self.init(oldIds: oldIds, newIds: newIds) { oldIndex, newIndex in old[oldIndex] != new[newIndex] }
    }

    /// The same from ids alone, with `changed(old, new)` telling whether a
    /// row that kept its id needs drawing again.
    public init<ID: Hashable>(oldIds: [ID], newIds: [ID], changed: (_ oldIndex: Int, _ newIndex: Int) -> Bool) {
        var deletes: [Int] = []
        var inserts: [Int] = []
        var moves: [Move] = []
        if oldIds != newIds {
            for change in newIds.difference(from: oldIds).inferringMoves() {
                switch change {
                case .remove(let offset, _, let associated):
                    if let associated {
                        moves.append(Move(from: offset, to: associated))
                    } else {
                        deletes.append(offset)
                    }
                case .insert(let offset, _, let associated):
                    if associated == nil { inserts.append(offset) }
                }
            }
        }
        var reconfigures: [Int] = []
        if deletes.isEmpty && inserts.isEmpty && moves.isEmpty {
            // The common case: same rows, same order.
            for index in newIds.indices where changed(index, index) {
                reconfigures.append(index)
            }
        } else {
            var oldIndex: [ID: Int] = [:]
            oldIndex.reserveCapacity(oldIds.count)
            for (index, id) in oldIds.enumerated() where oldIndex[id] == nil {
                oldIndex[id] = index
            }
            for (index, id) in newIds.enumerated() {
                if let previous = oldIndex[id], changed(previous, index) {
                    reconfigures.append(index)
                }
            }
        }
        self.deletes = deletes.sorted()
        self.inserts = inserts.sorted()
        self.moves = moves.sorted { $0.from < $1.from }
        self.reconfigures = reconfigures
    }

    /// Nothing to do: the list already shows these rows.
    public var isEmpty: Bool {
        deletes.isEmpty && inserts.isEmpty && moves.isEmpty && reconfigures.isEmpty
    }

    /// Membership or order changed, so the list needs a batch update rather
    /// than reconfigured rows alone.
    public var isStructural: Bool {
        !deletes.isEmpty || !inserts.isEmpty || !moves.isEmpty
    }

    /// How many rows the update touches, for the apply counters.
    public var touchedRows: Int {
        deletes.count + inserts.count + moves.count + reconfigures.count
    }
}
