#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// A profile's settings page as a list of what is on it: each row's id,
/// title and icon. The page draws its rows from these, and home's search
/// finds them here, so the two can never name a setting differently.
enum SettingsIndex {
    struct Entry: Equatable {
        var id: String
        var title: String
        var glyph: String
        var tile: SettingsRow.Tile
    }

    static var profile: Entry { Entry(id: "profile", title: Strings.Profile.title, glyph: "person-circle-outline", tile: .gray) }
    static var changeAgentName: Entry { Entry(id: "change-agent-name", title: Strings.changeAgentName, glyph: "create-outline", tile: .blue) }
    static var changeAgentAvatar: Entry { Entry(id: "change-agent-avatar", title: Strings.changeAgentAvatar, glyph: "image-outline", tile: .orange) }
    static var hideProjects: Entry { Entry(id: "hide-projects", title: "Hide projects", glyph: "folder-outline", tile: .orange) }
    static var account: Entry { Entry(id: "account", title: Strings.Settings.account, glyph: "person-circle-outline", tile: .blue) }
    static var backupRestore: Entry { Entry(id: "backup-restore", title: Strings.BackupRestore.title, glyph: "key-outline", tile: .green) }
    static var language: Entry { Entry(id: "language", title: Strings.SettingsLanguage.title, glyph: "language-outline", tile: .green) }
    static var voice: Entry { Entry(id: "voice", title: Strings.Voice.title, glyph: "mic-outline", tile: .orange) }
    static var agents: Entry { Entry(id: "agents", title: Strings.Settings.agents, glyph: "options-outline", tile: .teal) }
    static var scanTerminal: Entry { Entry(id: "scan-terminal", title: Strings.connectTerminal, glyph: "qr-code-outline", tile: .indigo) }
    static var enterTerminal: Entry { Entry(id: "enter-terminal", title: Strings.enterTerminalURL, glyph: "link-outline", tile: .indigo) }
    static var supportUs: Entry { Entry(id: "support-us", title: Strings.SupportUs.title, glyph: "heart-outline", tile: .red) }
    static var appearance: Entry { Entry(id: "appearance", title: Strings.Settings.appearance, glyph: "color-palette-outline", tile: .purple) }
    static var about: Entry { Entry(id: "about", title: Strings.Settings.about, glyph: "information-circle-outline", tile: .gray) }
    static var connectAgent: Entry { Entry(id: "connect-agent", title: Strings.SettingsActions.addAgent, glyph: "add-outline", tile: .action) }
    static var addAccount: Entry { Entry(id: "add-account", title: Strings.addHappyAccount, glyph: "person-add-outline", tile: .gray) }
    static var whatsNew: Entry { Entry(id: "whats-new", title: Strings.Settings.whatsNew, glyph: "sparkles-outline", tile: .orange) }
    static var githubRepo: Entry { Entry(id: "github-repo", title: Strings.Settings.github, glyph: "logo-github", tile: .gray) }
    static var reportIssue: Entry { Entry(id: "report-issue", title: Strings.Settings.reportIssue, glyph: "bug-outline", tile: .red) }
    static var privacy: Entry { Entry(id: "privacy", title: Strings.Settings.privacyPolicy, glyph: "shield-checkmark-outline", tile: .blue) }
    static var terms: Entry { Entry(id: "terms", title: Strings.Settings.termsOfService, glyph: "document-text-outline", tile: .gray) }
    static var eula: Entry { Entry(id: "eula", title: Strings.Settings.eula, glyph: "document-text-outline", tile: .gray) }
    static var version: Entry { Entry(id: "version", title: Strings.Common.version, glyph: "information-circle-outline", tile: .gray) }

    /// What a computer's settings show, its pages' rows and the agent's
    /// picture's menu (the two asks) included, in their order. Disconnect is left
    /// out: a search doesn't offer to take the computer away.
    static var computer: [Entry] {
        [profile, changeAgentName, changeAgentAvatar, appearance, hideProjects, supportUs, connectAgent, addAccount] + aboutRows
    }

    /// What a Happy account's settings show under its accounts card, in
    /// their order: the same places as a computer's, with the account's own
    /// pages beside them. Sign out is left out, as Disconnect is.
    static var happyAccount: [Entry] {
        [account, backupRestore, appearance, language, voice, agents, scanTerminal, enterTerminal, supportUs] + aboutRows
    }

    /// The About page's rows.
    static var aboutRows: [Entry] { [whatsNew, githubRepo, reportIssue, privacy, terms, eula, version] }
}

extension SettingsRow {
    /// `entry`'s row: its id, title and icon.
    init(_ entry: SettingsIndex.Entry, image: UIImage? = nil, value: String? = nil, accessory: SettingsLayout.Accessory = .chevron, isOn: Bool = false, action: (() -> Void)? = nil, toggled: ((Bool) -> Void)? = nil) {
        self.init(id: entry.id, title: entry.title, icon: (entry.glyph, entry.tile), image: image, value: value, accessory: accessory, isOn: isOn, action: action, toggled: toggled)
    }
}
#endif
