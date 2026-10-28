#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// A computer's settings page as a list of what is on it: each row's id,
/// title and icon. The page draws its rows from these, and home's search
/// finds them here, so the two can never name a setting differently.
enum StemCellsSettingsIndex {
    struct Entry: Equatable {
        var id: String
        var title: String
        var glyph: String
        var tile: StemCellsSettingsRow.Tile
    }

    static var editName: Entry { Entry(id: "edit-name", title: Strings.StemCells.editName, glyph: "create-outline", tile: .blue) }
    static var status: Entry { Entry(id: "status", title: Strings.StemCells.status, glyph: "desktop-outline", tile: .green) }
    static var hideProjects: Entry { Entry(id: "hide-projects", title: "Hide projects", glyph: "folder-outline", tile: .orange) }
    static var stories: Entry { Entry(id: "stories", title: Strings.Stories.setting, glyph: "sparkles-outline", tile: .blue) }
    static var directConnection: Entry { Entry(id: "direct-connection", title: Strings.StemCells.directConnection, glyph: "flask-outline", tile: .purple) }
    static var theme: Entry { Entry(id: "theme", title: Strings.SettingsAppearance.theme, glyph: "contrast-outline", tile: .indigo) }
    static var addComputer: Entry { Entry(id: "add-computer", title: Strings.StemCells.addComputer, glyph: "laptop-outline", tile: .blue) }
    static var addAccount: Entry { Entry(id: "add-account", title: Strings.StemCells.addHappyAccount, glyph: "person-add-outline", tile: .gray) }
    static var whatsNew: Entry { Entry(id: "whats-new", title: Strings.Settings.whatsNew, glyph: "sparkles-outline", tile: .orange) }
    static var githubRepo: Entry { Entry(id: "github-repo", title: Strings.Settings.github, glyph: "logo-github", tile: .gray) }
    static var reportIssue: Entry { Entry(id: "report-issue", title: Strings.Settings.reportIssue, glyph: "bug-outline", tile: .red) }
    static var privacy: Entry { Entry(id: "privacy", title: Strings.Settings.privacyPolicy, glyph: "shield-checkmark-outline", tile: .blue) }
    static var terms: Entry { Entry(id: "terms", title: Strings.Settings.termsOfService, glyph: "document-text-outline", tile: .gray) }
    static var eula: Entry { Entry(id: "eula", title: Strings.Settings.eula, glyph: "document-text-outline", tile: .gray) }
    static var version: Entry { Entry(id: "version", title: Strings.Common.version, glyph: "information-circle-outline", tile: .gray) }

    /// What a computer's page may show, in its order. Disconnect is left
    /// out: a search doesn't offer to take the computer away. Stories
    /// only where the computer offers them, as the page shows them.
    static func computer(stories: Bool) -> [Entry] {
        [editName, status, hideProjects] + (stories ? [Self.stories] : []) + [directConnection, theme, addComputer, addAccount] + about
    }

    /// About, on every page.
    static var about: [Entry] { [whatsNew, githubRepo, reportIssue, privacy, terms, eula, version] }
}

extension StemCellsSettingsRow {
    /// `entry`'s row: its id, title and icon.
    init(_ entry: StemCellsSettingsIndex.Entry, value: String? = nil, accessory: StemCellsSettingsLayout.Accessory = .chevron, isOn: Bool = false, action: (() -> Void)? = nil, toggled: ((Bool) -> Void)? = nil) {
        self.init(id: entry.id, title: entry.title, icon: (entry.glyph, entry.tile), value: value, accessory: accessory, isOn: isOn, action: action, toggled: toggled)
    }
}
#endif
