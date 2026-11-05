import Foundation

/// The rows a list has on screen, by ID, as it reports each row's visible
/// part.
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
