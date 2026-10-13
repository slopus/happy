import Foundation

/// A pure composer transformation invoked inside the session's write transaction.
/// HappyCore supplies the mode rule without making HappyStore depend on HappyCore.
public typealias SessionComposerReconciliation = @Sendable (SessionRecord, ComposerStateRecord) -> ComposerStateRecord