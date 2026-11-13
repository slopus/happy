import Foundation
import HappyCore

// A Happy Cloud server's plugins, in desktop's words (HappyAgentPluginsPage).
extension Strings {
    enum Plugins {
        static let title = "Plugins"
        static let installed = "Installed"
        static let available = "Available"
        static let tools = "Tools"
        static let loading = "Loading plugins…"
        static let loadFailed = "Couldn’t load the plugins."
        static let tryAgain = "Try Again"
        static let nothingInstalled = "Nothing installed yet"
        static let nothingInstalledHint = "Install a plugin below to give agents its tools."
        static let noneOffered = "This server offers no plugins yet."
        static let membersCantInstall = "Only people who manage plugins can install them and see what is installed."
        static let membersCantSetUp = "Only people who manage plugins can install and set them up."
        static let notOffered = "This server doesn’t offer this plugin."
        static let noLongerOffered = "This server no longer offers this plugin."
        static let installedValue = "Installed"
        static let status = "Status"
        static func version(_ version: String) -> String { "Version \(version)" }
        static func toolPrefix(_ prefix: String) -> String { "Agents call its tools as \(prefix)…" }

        static func status(_ installation: PluginInstallation) -> String {
            guard installation.available else { return "Unavailable" }
            switch installation.status {
            case .active: return "Ready"
            case .notConfigured: return "Needs setup"
            case .methodUnavailable: return "Needs setup again"
            }
        }
    }
}
