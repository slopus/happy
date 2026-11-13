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

        static let install = "Install"
        static let installAgain = "Install Again"
        static func setUp(with method: String) -> String { "Set up with \(method)" }
        static let signOut = "Sign Out"
        static let remove = "Remove"
        static func removeTitle(_ name: String) -> String { "Remove \(name)?" }
        static let removeMessage = "Its sign-in and everything it stored are deleted, and agents lose its tools."
        static let removeConfirm = "Remove Plugin"
        static let connect = "Connect"
        static let installFailed = "Couldn’t install the plugin"
        static let removeFailed = "Couldn’t remove the plugin"
        static let signOutFailed = "Couldn’t sign out"
        static let connectFailed = "Couldn’t start the sign-in"
        static let setupFailed = "Couldn’t set up the plugin"
        static let setupHint = "Sent once to the server and kept there, never on this phone."

        static func words(_ error: any Error) -> String {
            if let refusal = Strings.refusal(error) { return refusal }
            switch error {
            case let refusal as PluginFieldsRefusal: return refusal.message ?? "Some fields were refused."
            case AgentClientError.status(501, _, _): return "This server can’t do sign-ins like this yet."
            case AgentClientError.status(_, _, let message?): return message
            default: return error.localizedDescription
            }
        }

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
