import Foundation
import HappyCore

extension Strings {
    /// What VoiceOver says of a Gen UI's controls beyond their labels. Not
    /// in happy-app's catalogs: every language's are in
    /// `TranslationCatalog.nativeSources` (`genUISources`).
    enum GenUI {
        /// A choice that was made.
        static var selected: String { localized("native.genui.selected", "Selected") }
        /// A button whose action can't run where it is shown.
        static var unavailable: String { localized("native.genui.unavailable", "Unavailable here") }
        /// A secret action whose form saved.
        static var saved: String { localized("native.genui.saved", "Saved") }
    }
}

extension Strings {
    /// The Happy Agent secret form a Gen UI `secret` action opens
    /// (`GenUISecretFormViewController`). Not in happy-app's catalogs: every
    /// language's are in `TranslationCatalog.nativeSources` (`genUISecretSources`).
    enum GenUISecret {
        static var newTitle: String { localized("native.genuiSecret.newTitle", "New Secret") }
        static var changeTitle: String { localized("native.genuiSecret.changeTitle", "Change Secret") }
        static var addedTitle: String { localized("native.genuiSecret.addedTitle", "Secret Added") }
        static var updatedTitle: String { localized("native.genuiSecret.updatedTitle", "Secret Updated") }
        static var done: String { localized("native.genuiSecret.done", "Done") }
        static var name: String { localized("native.genuiSecret.name", "Name") }
        static let namePlaceholder = "stripe"
        static var nameProblem: String { localized("native.genuiSecret.nameProblem", "2–32 characters: a lowercase letter, then lowercase letters, digits, _ or -.") }
        static var checking: String { localized("native.genuiSecret.checking", "Checking for a secret with this name…") }
        static var changes: String { localized("native.genuiSecret.changes", "A secret with this name exists. Saving changes it; a value left empty keeps what is stored.") }
        static var managed: String { localized("native.genuiSecret.managed", "This secret is managed by Happy Agent and can’t be changed here.") }
        static var description: String { localized("native.genuiSecret.description", "Description") }
        static var descriptionPlaceholder: String { localized("native.genuiSecret.descriptionPlaceholder", "What these values are for") }
        static var descriptionProblem: String { localized("native.genuiSecret.descriptionProblem", "Say what the secret is for, in at most 2,000 characters.") }
        static var variables: String { localized("native.genuiSecret.variables", "Variables") }
        static var variableName: String { localized("native.genuiSecret.variableName", "Variable name") }
        static let variablePlaceholder = "API_KEY"
        static var value: String { localized("native.genuiSecret.value", "Value") }
        static var keepPlaceholder: String { localized("native.genuiSecret.keepPlaceholder", "Keep the stored value") }
        static var valueMissing: String { localized("native.genuiSecret.valueMissing", "Needs a value") }
        static var remove: String { localized("native.genuiSecret.remove", "Remove Variable") }
        static func removeNamed(_ name: String) -> String {
            name.isEmpty ? remove : localized("native.genuiSecret.removeNamed", ["name": .text(name)], "Remove \(name)")
        }
        static var add: String { localized("native.genuiSecret.add", "Add Variable") }
        static var noVariables: String { localized("native.genuiSecret.noVariables", "Add at least one variable.") }
        static var variableNameProblem: String { localized("native.genuiSecret.variableNameProblem", "Variable names are letters, digits and _, not starting with a digit.") }
        static var variableTwice: String { localized("native.genuiSecret.variableTwice", "Each variable needs its own name.") }
        static var valueProblem: String { localized("native.genuiSecret.valueProblem", "Type a value for every variable.") }
        static var about: String { localized("native.genuiSecret.about", "Values go straight to your computer and are never shown to the agent. It is told the secret’s name and its variables.") }
        static func added(_ name: String) -> String { localized("native.genuiSecret.added", ["name": .text(name)], "Added \(name)") }
        static func updated(_ name: String) -> String { localized("native.genuiSecret.updated", ["name": .text(name)], "Updated \(name)") }
        static func told(_ names: [String]) -> String {
            let names = names.joined(separator: ", ")
            return localized("native.genuiSecret.told", ["names": .text(names)],
                             "The agent can now use \(names). It was told in its conversation; the values stay on your computer.")
        }
        static var failedTitle: String { localized("native.genuiSecret.failedTitle", "Couldn’t Save") }
        static var stale: String { localized("native.genuiSecret.stale", "The secret changed since this form opened. It shows the secret as it is now; check it and save again.") }
        static var exists: String { localized("native.genuiSecret.exists", "A secret with this name already exists. The form now changes it; check it and save again.") }
        static var conflict: String { localized("native.genuiSecret.conflict", "The computer can’t save this here. The agent that asked may be gone, or the secret is managed elsewhere.") }
        static var refused: String { localized("native.genuiSecret.refused", "The computer refused this form. Check the name, description and variables.") }
        static var unavailable: String { localized("native.genuiSecret.unavailable", "This computer can’t save secrets from here.") }
        static var failed: String { localized("native.genuiSecret.failed", "Couldn’t reach the computer. Your values are still in the form; try again.") }
    }
}

extension Strings {
    /// The Happy Cloud secret form a Gen UI `cluster_secret` action opens
    /// (`GenUIClusterSecretFormViewController`): its own words in
    /// `genUIClusterSecretSources`, the rest the Happy Agent form's.
    enum GenUIClusterSecret {
        typealias Method = GenUIClusterSecretDraft.Method
        private typealias Shared = GenUISecret

        static var newTitle: String { Shared.newTitle }
        static var changeTitle: String { Shared.changeTitle }
        static var addedTitle: String { Shared.addedTitle }
        static var updatedTitle: String { Shared.updatedTitle }
        static var done: String { Shared.done }
        static var name: String { Shared.name }
        static var description: String { Shared.description }
        static var descriptionPlaceholder: String { Shared.descriptionPlaceholder }
        static var descriptionProblem: String { Shared.descriptionProblem }
        static var keepPlaceholder: String { Shared.keepPlaceholder }
        static var valueMissing: String { Shared.valueMissing }
        static var variables: String { Shared.variables }
        static var addVariable: String { Shared.add }
        static var values: String { Shared.value }
        static var failedTitle: String { Shared.failedTitle }
        static func added(_ name: String) -> String { Shared.added(name) }
        static func updated(_ name: String) -> String { Shared.updated(name) }
        static let namePlaceholder = "Stripe API"
        static let variablePlaceholder = "API_KEY"
        static let hostPlaceholder = "api.example.com"
        static let portsPlaceholder = "443"
        static let pathsPlaceholder = "/v1/"
        static let methodsPlaceholder = "GET, POST"
        static let headerPlaceholder = "Authorization"
        static let prefixPlaceholder = "Bearer "
        static let hostsPlaceholder = "github.com, *.example.com"
        static let sshPortsPlaceholder = "22"
        static let serverPlaceholder = "github.com"
        static let knownHostPlaceholder = "github.com ssh-ed25519 AAAA…"
        static let keyPlaceholder = "-----BEGIN OPENSSH PRIVATE KEY-----"

        static var loading: String { localized("native.genuiClusterSecret.loading", "Loading the secret…") }
        static var remove: String { localized("native.genuiClusterSecret.remove", "Remove") }
        static var nameProblem: String { localized("native.genuiClusterSecret.nameProblem", "Give the secret a name of at most 100 characters, without spaces around it.") }
        static var owner: String { localized("native.genuiClusterSecret.owner", "Owner") }
        static var me: String { localized("native.genuiClusterSecret.me", "Me") }
        static var team: String { localized("native.genuiClusterSecret.team", "Team") }
        static var ownerNote: String { localized("native.genuiClusterSecret.ownerNote", "A team secret can be granted to the team’s agents; yours only to your own.") }
        static var uses: String { localized("native.genuiClusterSecret.uses", "Used for") }
        static func use(_ use: String) -> String {
            switch use {
            case "egress": localized("native.genuiClusterSecret.use.egress", "Web requests")
            case "mcp": localized("native.genuiClusterSecret.use.mcp", "MCP servers")
            case "ssh": localized("native.genuiClusterSecret.use.ssh", "SSH")
            case "git": localized("native.genuiClusterSecret.use.git", "Git")
            case "environment": localized("native.genuiClusterSecret.use.environment", "Environment variables")
            default: use
            }
        }
        static var usesProblem: String { localized("native.genuiClusterSecret.usesProblem", "Choose at least one use.") }
        static var targets: String { localized("native.genuiClusterSecret.targets", "Where it is sent") }
        static var addTarget: String { localized("native.genuiClusterSecret.addTarget", "Add Host") }
        static var targetsProblem: String { localized("native.genuiClusterSecret.targetsProblem", "Every host needs a name, and ports are numbers from 1 to 65535.") }
        static var targetsNote: String { localized("native.genuiClusterSecret.targetsNote", "Only requests to these hosts get the headers. Ports, paths and methods are optional and comma-separated.") }
        static var headers: String { localized("native.genuiClusterSecret.headers", "Headers") }
        static var addHeader: String { localized("native.genuiClusterSecret.addHeader", "Add Header") }
        static var headersProblem: String { localized("native.genuiClusterSecret.headersProblem", "Every header needs a name.") }
        static var headersNote: String { localized("native.genuiClusterSecret.headersNote", "The proxy adds each header with its value to the request; the agent never sees the value.") }
        static var portsLabel: String { localized("native.genuiClusterSecret.portsLabel", "Ports") }
        static var pathsLabel: String { localized("native.genuiClusterSecret.pathsLabel", "Paths") }
        static var methodsLabel: String { localized("native.genuiClusterSecret.methodsLabel", "Methods") }
        static var prefixLabel: String { localized("native.genuiClusterSecret.prefixLabel", "Prefix") }
        static func valueOf(_ name: String) -> String {
            name.isEmpty ? Shared.value : localized("native.genuiClusterSecret.valueOf", ["name": .text(name)], "Value of \(name)")
        }
        static var sshHosts: String { localized("native.genuiClusterSecret.sshHosts", "Hosts") }
        static var hostsProblem: String { localized("native.genuiClusterSecret.hostsProblem", "Name at least one host.") }
        static var portProblem: String { localized("native.genuiClusterSecret.portProblem", "Ports are numbers from 1 to 65535.") }
        static var server: String { localized("native.genuiClusterSecret.server", "Server") }
        static var serverProblem: String { localized("native.genuiClusterSecret.serverProblem", "Name the Git server.") }
        static var method: String { localized("native.genuiClusterSecret.method", "Sign in with") }
        static func method(_ method: Method) -> String {
            switch method {
            case .sshKey: localized("native.genuiClusterSecret.method.sshKey", "SSH Key")
            case .password: localized("native.genuiClusterSecret.method.password", "Password")
            case .token: localized("native.genuiClusterSecret.method.token", "Token")
            }
        }
        static func methodNote(_ method: Method) -> String {
            switch method {
            case .sshKey: localized("native.genuiClusterSecret.methodNote.sshKey", "Git connects over SSH with the key below.")
            case .password: localized("native.genuiClusterSecret.methodNote.password", "Git signs in over HTTPS with this username and a password.")
            case .token: localized("native.genuiClusterSecret.methodNote.token", "Git signs in over HTTPS with a token; the username is optional.")
            }
        }
        static var access: String { localized("native.genuiClusterSecret.access", "Access") }
        static func operation(_ operation: String) -> String {
            switch operation {
            case "read": localized("native.genuiClusterSecret.operation.read", "Read")
            case "write": localized("native.genuiClusterSecret.operation.write", "Write")
            case "sign": localized("native.genuiClusterSecret.operation.sign", "Sign commits")
            default: operation
            }
        }
        static var valuesNote: String { localized("native.genuiClusterSecret.valuesNote", "Typed once and sent straight to Happy Cloud. The agent never sees it.") }
        static var knownHosts: String { localized("native.genuiClusterSecret.knownHosts", "Known hosts") }
        static var addKnownHost: String { localized("native.genuiClusterSecret.addKnownHost", "Add Known Host") }
        static var knownHostsNote: String { localized("native.genuiClusterSecret.knownHostsNote", "Optional known_hosts lines to pin the server’s key.") }
        static var keyNote: String { localized("native.genuiClusterSecret.keyNote", "Paste the private key; a passphrase is optional. Happy Cloud keeps it and derives the public key.") }
        static var portLabel: String { localized("native.genuiClusterSecret.portLabel", "Port") }
        static var usernameLabel: String { localized("native.genuiClusterSecret.usernameLabel", "Username") }
        static var reposLabel: String { localized("native.genuiClusterSecret.reposLabel", "Repos") }
        static var passphraseLabel: String { localized("native.genuiClusterSecret.passphraseLabel", "Passphrase") }
        static var optional: String { localized("native.genuiClusterSecret.optional", "Optional") }
        static var portPlaceholder: String { localized("native.genuiClusterSecret.portPlaceholder", "Default") }
        static func usernamePlaceholder(_ method: Method) -> String { method == .token ? optional : "git" }
        static var reposPlaceholder: String { localized("native.genuiClusterSecret.reposPlaceholder", "owner/repo, all when empty") }
        static var passwordPlaceholder: String { method(.password) }
        static var tokenPlaceholder: String { method(.token) }
        static var passphrasePlaceholder: String { optional }
        static var variablesProblem: String { localized("native.genuiClusterSecret.variablesProblem", "Variable names are letters, digits and _, not starting with a digit, each its own.") }
        static var about: String { localized("native.genuiClusterSecret.about", "Values go straight to Happy Cloud and are never shown to the agent. It is granted the secret and told its name.") }
        static var moves: String { localized("native.genuiClusterSecret.moves", "This changes where the values go, so type each one again.") }
        static var changes: String { localized("native.genuiClusterSecret.changes", "Saving changes this stored secret; a value left empty keeps what is stored.") }
        static var resaving: String { localized("native.genuiClusterSecret.resaving", "This form saved this secret before. Saving changes it again, with every value typed again.") }
        static var told: String { localized("native.genuiClusterSecret.told", "The agent can now use it. It was told in its conversation; the values stay in Happy Cloud.") }
        static var toldUngranted: String { localized("native.genuiClusterSecret.toldUngranted", "The secret is saved. The agent was told, but couldn’t be granted it; grant it from the secret’s page.") }
        static var failed: String { localized("native.genuiClusterSecret.failed", "Couldn’t reach Happy Cloud. Your values are still in the form; try again.") }
        static var noOrigin: String { localized("native.genuiClusterSecret.noOrigin", "The agent that asked for this secret is gone, so it can’t be granted. Ask again from its conversation.") }
        static var forbidden: String { localized("native.genuiClusterSecret.forbidden", "You can’t save this secret here.") }
        static var unavailable: String { localized("native.genuiClusterSecret.unavailable", "This artifact can’t save secrets anymore.") }
    }
}
