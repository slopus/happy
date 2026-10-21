import Foundation

/// A pure composer transformation invoked inside the session's write transaction.
/// HappyCore supplies the mode rule without making HappyStore depend on HappyCore.
public typealias SessionComposerReconciliation = @Sendable (
    SessionRecord, SessionRecord?, ComposerStateRecord, DraftRecord?
) -> SessionComposerState

/// Composer and draft returned together for one atomic session transaction.
public struct SessionComposerState: Sendable {
    public var composer: ComposerStateRecord
    public var draft: DraftRecord?

    public init(composer: ComposerStateRecord, draft: DraftRecord?) {
        self.composer = composer
        self.draft = draft
    }
}
