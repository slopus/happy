#if canImport(UIKit)
import HappyCore

/// What every list of accounts calls one (the switcher, Settings, Manage
/// Accounts). An account with no name of its own goes by its kind: Happy
/// Agent for an agent connection, Happy CLI for a Happy account on the
/// relay, legacy or made for a computer; one made for a computer's code
/// goes by the first computer paired with it once that arrives.
extension AccountSummary {
    var shownName: String {
        resolvedName ?? kindName
    }

    /// What kind of account it is, said where the name would be or under it.
    var kindName: String {
        isAgentConnection ? Strings.agentConnection : Strings.legacyAccount
    }
}
#endif
