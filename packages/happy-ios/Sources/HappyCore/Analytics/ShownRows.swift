import Foundation

/// The rows a list has on screen, by ID, as it reports each row's visible
/// part: what an event that fires on what a person saw is read from.
public struct ShownRows: Equatable, Sendable {
    public private(set) var ids: Set<String> = []

    public init() {}

    /// A row's visible part changed. True when it has just come on screen.
    public mutating func update(_ id: String, shown: Bool) -> Bool {
        guard shown else {
            ids.remove(id)
            return false
        }
        return ids.insert(id).inserted
    }
}

extension ChatSnapshot {
    /// The failure cards among the items, by item ID.
    public var failuresByID: [String: Failure] {
        Dictionary(items.compactMap { item in
            if case .failure(let failure) = item.role { (item.id, failure) } else { nil }
        }, uniquingKeysWith: { $1 })
    }
}
