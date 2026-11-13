import Foundation
import HappyCore

// Adding inference providers on Happy Cloud: this app's own screens. The
// words are shared with Android and desktop, word for word.
extension Strings {
    enum Providers {
        static let title = "Inference"
        static let included = "Included"
        static let team = "Team"
        static let mine = "My account"
        static let empty = "Nothing added yet"
        static let off = "Off"
        static let needsAttention = "Needs attention"
        static func credentials(_ count: Int) -> String { count == 1 ? "1 credential" : "\(count) credentials" }
        static let add = "Add a provider"
        static let footer = "A chat runs on the connection you pick for it. Keys and sign-ins are kept on the server, never on this phone."
        static func footer(_ section: CloudProvider.Section) -> String {
            switch section {
            case .included: "Included with Happy Cloud."
            case .team: "Shared with everyone on this server."
            case .mine: "Only you can use these."
            }
        }
        static let loadFailed = "Couldn’t load the providers."

        static let signInChatGPT = "Sign in with ChatGPT"
        static let claudeSetupToken = "Use a Claude setup token"
        static let addAPIKey = "Add API key"
        static let openAI = "OpenAI"
        static let anthropic = "Anthropic"
        static let grok = "Grok"
        static let custom = "Custom provider"
        /// The chooser's families, each with a line for its ways, and the
        /// ways where a family has two.
        static func family(_ kind: ProviderFamily.Kind) -> String {
            switch kind {
            case .chatGPT: "ChatGPT"
            case .claude: "Claude"
            case .grok: grok
            case .custom: "Custom"
            }
        }
        static func ways(_ family: ProviderFamily) -> String {
            if family.kind == .custom { return "Any endpoint that speaks OpenAI’s API" }
            let ways = family.methods.map { method in
                switch method {
                case .signIn: "Sign in"
                case .setupToken: "Setup token"
                case .apiKey: family.methods.count == 1 && family.kind == .grok ? "xAI API key" : "API key"
                case .custom: ""
                }
            }
            return ways.count == 2 ? "\(ways[0]) or \(ways[1])" : ways.joined()
        }
        static func method(_ method: ProviderFamily.Method) -> (title: String, detail: String) {
            switch method {
            case .signIn: (signInChatGPT, "Uses your ChatGPT plan")
            case .setupToken: ("Use a setup token", "Uses your Claude plan, from claude setup-token")
            case .apiKey(let vendor):
                vendor == "anthropic" ? ("Anthropic API key", "Billed to your Anthropic account")
                    : vendor == "grok" ? ("xAI API key", "Billed to your xAI account")
                    : ("OpenAI API key", "Billed to your OpenAI account")
            case .custom: (custom, customBaseUrlHelp)
            }
        }
        static let customName = "Name"
        static let customNamePlaceholder = "Together AI"
        static let customBaseUrl = "Base URL"
        static let customBaseUrlHelp = "An endpoint that speaks OpenAI’s Responses API."
        static let customModel = "Model ID"
        static let customModelPlaceholder = "llama-4-maverick"
        static let customFooter = "Shared with everyone on this server. The key is sent once and kept on the server, never on this phone."
        static let customFailed = "Couldn’t add the provider"
        static let addAction = "Add"
        static let saveTo = "Save to"
        static let destinationRefused = "Can’t add to this connection"
        static let destinationRefusedHint = "You don’t have permission to save providers to the requested connection. Nothing was added."

        static let deviceInstructions = "Enter this code at OpenAI"
        static let copy = "Copy"
        static let copied = "Copied"
        static let openOpenAI = "Open OpenAI"
        static let waiting = "Waiting for you to finish…"

        static let connect = "Connect"
        static let addSetupToken = "Add setup token"
        static let setupToken = "Setup token"
        static let setupTokenHint = "From `claude setup-token` on your computer."

        static let apiKey = "API key"
        static let checking = "Checking the key…"

        static let chatGPTConnected = "ChatGPT connected"
        static let claudeConnected = "Claude connected"
        static let keyAdded = "API key added"
        static let codeExpired = "Code expired"
        static let signInFailed = "Sign-in failed"
        static let couldNotAddKey = "Couldn’t add the key"
        static let tryAgain = "Try Again"
        static let notAvailable = "This server doesn’t offer this sign-in yet."
    }
}
