import Foundation
import GRDB
import HappyStore
import HappyWire

/// Nonsecret switcher presentation cached in the registry. The current RN
/// profile has no username field; its GitHub login supplies that label.
public struct AccountDisplay: Codable, Equatable, Sendable {
    public var name: String?
    public var username: String?
    public var avatarURL: URL?
    public var avatarThumbhash: String?

    public init(profile: AccountProfile) {
        name = profile.displayName
        username = profile.github?.login
        avatarURL = profile.avatarURL.flatMap(URL.init(string:))
        avatarThumbhash = profile.avatar?.thumbhash
    }

    /// Reads an inactive account's profile without opening a LocalStore,
    /// applying migrations, or resetting any of that account's live state.
    static func read(directory: URL, id: String) throws -> AccountDisplay? {
        let url = AccountSession.accountDirectory(directory: directory, id: id).appendingPathComponent("store.sqlite")
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        var configuration = Configuration()
        configuration.readonly = true
        configuration.busyMode = .timeout(2)
        let database = try DatabaseQueue(path: url.path, configuration: configuration)
        return try database.read { db in
            let profile = try AccountProfileRecord.fetchOne(db, key: 1)?.profile
            return profile.map(AccountDisplay.init)
        }
    }
}
