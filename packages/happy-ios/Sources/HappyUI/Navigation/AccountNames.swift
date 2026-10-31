#if canImport(UIKit)
import HappyCore

/// What every list of accounts calls one (the switcher, Settings, Manage
/// Accounts). "Legacy Account" is only for accounts carried over or
/// restored from elsewhere; one made for a computer's code goes by the
/// first computer paired with it, and is an agent until that arrives.
extension AccountSummary {
    var shownName: String {
        resolvedName ?? kindName
    }

    /// What kind of account it is, said where the name would be or under it.
    var kindName: String {
        isLegacy ? Strings.legacyAccount : Strings.agentConnection
    }
}
#endif
