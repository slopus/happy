import Foundation

/// One account signed in on this device, as the account switcher lists it.
/// Everything here is known without the network: it comes from the account
/// registry and the account's own store.
public struct AccountSummary: Equatable, Sendable, Identifiable {
    /// Stable on this device and derived from the account's secret (its
    /// anonymous id), so the same account signed in twice is one entry.
    public var id: String
    public var serverURL: URL
    /// From the account's stored profile; nil until it has been fetched.
    public var name: String?
    public var username: String?
    /// The profile picture's URL and thumbhash, when the profile has one.
    public var avatarURL: URL?
    public var avatarThumbhash: String?
    public var isActive: Bool
    /// Whether this account's credentials are the RN app's Keychain item
    /// (`app:no-auth` / `auth_credentials`) rather than an item of its own.
    public var usesSharedItem: Bool

    public init(id: String, serverURL: URL, name: String? = nil, username: String? = nil, avatarURL: URL? = nil, avatarThumbhash: String? = nil, isActive: Bool, usesSharedItem: Bool) {
        self.id = id
        self.serverURL = serverURL
        self.name = name
        self.username = username
        self.avatarURL = avatarURL
        self.avatarThumbhash = avatarThumbhash
        self.isActive = isActive
        self.usesSharedItem = usesSharedItem
    }
}

public enum AccountSwitchError: Error, Equatable, Sendable {
    case unknownAccount
    /// Multi-account isn't wired yet (placeholder until it lands).
    case notAvailable
}
