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
    /// (`GenUISecretFormViewController`). English until it is translated.
    enum GenUISecret {
        static let newTitle = "New Secret"
        static let changeTitle = "Change Secret"
        static let addedTitle = "Secret Added"
        static let updatedTitle = "Secret Updated"
        static let done = "Done"
        static let name = "Name"
        static let namePlaceholder = "stripe"
        static let nameProblem = "2–32 characters: a lowercase letter, then lowercase letters, digits, _ or -."
        static let checking = "Checking for a secret with this name…"
        static let changes = "A secret with this name exists. Saving changes it; a value left empty keeps what is stored."
        static let managed = "This secret is managed by Happy Agent and can’t be changed here."
        static let description = "Description"
        static let descriptionPlaceholder = "What these values are for"
        static let descriptionProblem = "Say what the secret is for, in at most 2,000 characters."
        static let variables = "Variables"
        static let variableName = "Variable name"
        static let variablePlaceholder = "API_KEY"
        static let value = "Value"
        static let valuePlaceholder = "Value"
        static let keepPlaceholder = "Keep the stored value"
        static let valueMissing = "Needs a value"
        static let remove = "Remove Variable"
        static func removeNamed(_ name: String) -> String { name.isEmpty ? remove : "Remove \(name)" }
        static let add = "Add Variable"
        static let noVariables = "Add at least one variable."
        static let variableNameProblem = "Variable names are letters, digits and _, not starting with a digit."
        static let variableTwice = "Each variable needs its own name."
        static let valueProblem = "Type a value for every variable."
        static let about = "Values go straight to your computer and are never shown to the agent. It is told the secret’s name and its variables."
        static func added(_ id: String) -> String { "Added \(id)" }
        static func updated(_ id: String) -> String { "Updated \(id)" }
        static func told(_ names: [String]) -> String {
            "The agent can now use \(names.joined(separator: ", ")). It was told in its conversation; the values stay on your computer."
        }
        static let failedTitle = "Couldn’t Save"
        static let stale = "The secret changed since this form opened. It shows the secret as it is now; check it and save again."
        static let exists = "A secret with this name already exists. The form now changes it; check it and save again."
        static let conflict = "The computer can’t save this here. The agent that asked may be gone, or the secret is managed elsewhere."
        static let refused = "The computer refused this form. Check the name, description and variables."
        static let unavailable = "This computer can’t save secrets from here."
        static let failed = "Couldn’t reach the computer. Your values are still in the form; try again."
    }
}

extension Strings {
    /// The Happy Cloud secret form a Gen UI `cluster_secret` action opens
    /// (`GenUIClusterSecretFormViewController`). English until it is translated.
    enum GenUIClusterSecret {
        typealias Method = GenUIClusterSecretDraft.Method

        static let newTitle = "New Secret"
        static let changeTitle = "Change Secret"
        static let addedTitle = "Secret Added"
        static let updatedTitle = "Secret Updated"
        static let loading = "Loading the secret…"
        static let valueMissing = "Needs a value"
        static let remove = "Remove"
        static let done = "Done"
        // General
        static let name = "Name"
        static let namePlaceholder = "Stripe API"
        static let nameProblem = "Give the secret a name of at most 100 characters, without spaces around it."
        static let description = "Description"
        static let descriptionPlaceholder = "What it is for"
        static let descriptionProblem = "Say what the secret is for, in at most 2,000 characters."
        static let owner = "Owner"
        static let me = "Me"
        static let team = "Team"
        static let ownerNote = "A team secret can be granted to the team’s agents; yours only to your own."
        static let uses = "Used for"
        static func use(_ use: String) -> String {
            switch use {
            case "egress": "Web requests"
            case "mcp": "MCP servers"
            case "ssh": "SSH"
            case "git": "Git"
            case "environment": "Environment variables"
            default: use
            }
        }
        static let usesProblem = "Choose at least one use."
        // Endpoint
        static let targets = "Where it is sent"
        static let addTarget = "Add Host"
        static let targetsProblem = "Every host needs a name, and ports are numbers from 1 to 65535."
        static let targetsNote = "Only requests to these hosts get the headers. Ports, paths and methods are optional and comma-separated."
        static let headers = "Headers"
        static let addHeader = "Add Header"
        static let headersProblem = "Every header needs a name."
        static let headersNote = "The proxy adds each header with its value to the request; the agent never sees the value."
        static let hostPlaceholder = "api.example.com"
        static let portsLabel = "Ports"
        static let pathsLabel = "Paths"
        static let methodsLabel = "Methods"
        static let prefixLabel = "Prefix"
        static let portsPlaceholder = "443"
        static let pathsPlaceholder = "/v1/"
        static let methodsPlaceholder = "GET, POST"
        static let headerPlaceholder = "Authorization"
        static let prefixPlaceholder = "Bearer "
        static let keepPlaceholder = "Keep the stored value"
        static func valueOf(_ name: String) -> String { name.isEmpty ? "Value" : "Value of \(name)" }
        // SSH key and Git
        static let sshHosts = "Hosts"
        static let hostsProblem = "Name at least one host."
        static let portProblem = "Ports are numbers from 1 to 65535."
        static let server = "Server"
        static let serverProblem = "Name the Git server."
        static let method = "Sign in with"
        static func method(_ method: Method) -> String {
            switch method {
            case .sshKey: "SSH Key"
            case .password: "Password"
            case .token: "Token"
            }
        }
        static func methodNote(_ method: Method) -> String {
            switch method {
            case .sshKey: "Git connects over SSH with the key below."
            case .password: "Git signs in over HTTPS with this username and a password."
            case .token: "Git signs in over HTTPS with a token; the username is optional."
            }
        }
        static let access = "Access"
        static func operation(_ operation: String) -> String {
            switch operation {
            case "read": "Read"
            case "write": "Write"
            case "sign": "Sign commits"
            default: operation
            }
        }
        static let values = "Value"
        static let valuesNote = "Typed once and sent straight to Happy Cloud. The agent never sees it."
        static let knownHosts = "Known hosts"
        static let addKnownHost = "Add Known Host"
        static let knownHostsNote = "Optional known_hosts lines to pin the server’s key."
        static let keyNote = "Paste the private key; a passphrase is optional. Happy Cloud keeps it and derives the public key."
        static let hostsPlaceholder = "github.com, *.example.com"
        static let portLabel = "Port"
        static let usernameLabel = "Username"
        static let reposLabel = "Repos"
        static let passphraseLabel = "Passphrase"
        static let optional = "Optional"
        static let sshPortsPlaceholder = "22"
        static let serverPlaceholder = "github.com"
        static let portPlaceholder = "Default"
        static func usernamePlaceholder(_ method: Method) -> String { method == .token ? optional : "git" }
        static let reposPlaceholder = "owner/repo, all when empty"
        static let passwordPlaceholder = "Password"
        static let tokenPlaceholder = "Token"
        static let knownHostPlaceholder = "github.com ssh-ed25519 AAAA…"
        static let keyPlaceholder = "-----BEGIN OPENSSH PRIVATE KEY-----"
        static let passphrasePlaceholder = optional
        // Environment
        static let variables = "Variables"
        static let addVariable = "Add Variable"
        static let variablesProblem = "Variable names are letters, digits and _, not starting with a digit, each its own."
        static let variablePlaceholder = "API_KEY"
        // Notes
        static let about = "Values go straight to Happy Cloud and are never shown to the agent. It is granted the secret and told its name."
        static let moves = "This changes where the values go, so type each one again."
        static let changes = "Saving changes this stored secret; a value left empty keeps what is stored."
        static let resaving = "This form saved this secret before. Saving changes it again, with every value typed again."
        // Done and failed
        static func added(_ name: String) -> String { "Added \(name)" }
        static func updated(_ name: String) -> String { "Updated \(name)" }
        static let told = "The agent can now use it. It was told in its conversation; the values stay in Happy Cloud."
        static let toldUngranted = "The secret is saved. The agent was told, but couldn’t be granted it; grant it from the secret’s page."
        static let failedTitle = "Couldn’t Save"
        static let failed = "Couldn’t reach Happy Cloud. Your values are still in the form; try again."
        static let noOrigin = "The agent that asked for this secret is gone, so it can’t be granted. Ask again from its conversation."
        static let forbidden = "You can’t save this secret here."
        static let unavailable = "This artifact can’t save secrets anymore."
    }
}
