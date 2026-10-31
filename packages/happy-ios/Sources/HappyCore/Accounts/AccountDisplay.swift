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
    /// The first computer paired with the account, by name: what an
    /// account made for a computer's code goes by.
    public var computerName: String?

    public init(name: String? = nil, username: String? = nil, avatarURL: URL? = nil, avatarThumbhash: String? = nil, computerName: String? = nil) {
        self.name = name
        self.username = username
        self.avatarURL = avatarURL
        self.avatarThumbhash = avatarThumbhash
        self.computerName = computerName
    }

    public init(profile: AccountProfile) {
        name = profile.displayName
        username = profile.github?.login
        avatarURL = profile.avatarURL.flatMap(URL.init(string:))
        avatarThumbhash = profile.avatar?.thumbhash
    }

    /// The profile's part and the computer's together; nil when neither
    /// is known.
    static func combined(_ profile: AccountProfile?, computerName: String?) -> AccountDisplay? {
        guard profile != nil || computerName != nil else { return nil }
        var display = profile.map(AccountDisplay.init) ?? AccountDisplay()
        display.computerName = computerName
        return display
    }

    /// The name of the computer paired first: the earliest machine the
    /// account has, by `MachineChoice.computerName` (a Happy Agent goes by
    /// its host). Nil while it has none.
    static func firstComputer(_ machines: [MachineRecord]) -> String? {
        guard let first = machines.min(by: { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }) else { return nil }
        let rig = MachineChoice.isRigMachine(first.metadata)
        let name = MachineChoice.computerName(happy: rig ? nil : first, rig: rig ? first : nil)
        return name == "Unknown machine" ? nil : name
    }

    /// Reads an inactive account's profile and computers without opening a
    /// LocalStore, applying migrations, or resetting any of that account's
    /// live state.
    static func read(directory: URL, id: String) throws -> AccountDisplay? {
        let url = AccountSession.accountDirectory(directory: directory, id: id).appendingPathComponent("store.sqlite")
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        var configuration = Configuration()
        configuration.readonly = true
        configuration.busyMode = .timeout(2)
        let database = try DatabaseQueue(path: url.path, configuration: configuration)
        return try database.read { db in
            let profile = try AccountProfileRecord.fetchOne(db, key: 1)?.profile
            return combined(profile, computerName: firstComputer(try MachineRecord.fetchAll(db)))
        }
    }

    static func read(_ store: LocalStore) throws -> AccountDisplay? {
        combined(try store.profile(), computerName: firstComputer(try store.machines()))
    }
}
