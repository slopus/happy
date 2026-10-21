import Foundation

extension ApplyPipeline {
    /// Follows the account's draft membership (`HomeFeed.draftSessions`)
    /// into the input at `ids`, off the main thread. A set equal to the one
    /// the input holds changes nothing and starts no derivation, so a
    /// keystroke in a draft that already exists wakes no one; a draft
    /// appearing or going is one derivation, which reconfigures the rows
    /// that draw it.
    public func followDrafts(_ feed: HomeFeed, into ids: WritableKeyPath<Input, Set<String>> & Sendable) {
        follow(ifChanged: feed.draftSessions()) { input, value in
            guard input[keyPath: ids] != value else { return false }
            input[keyPath: ids] = value
            return true
        }
    }
}
