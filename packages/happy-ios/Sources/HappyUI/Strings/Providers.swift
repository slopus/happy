import Foundation
import HappyCore

// Adding inference providers on Happy Cloud: this app's own screens. The
// words are shared with Android and desktop, word for word.
extension Strings {
    enum Providers {
        static let title = "AI providers"
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
        static let signInClaude = "Use a Claude setup token"
        static let addAPIKey = "Add API key"
        static let openAI = "OpenAI"
        static let anthropic = "Anthropic"
        static let grok = "Grok"
        static let saveTo = "Save to"
        static let destinationRefused = "Can’t add to this connection"
        static let destinationRefusedHint = "You don’t have permission to save providers to the requested connection. Nothing was added."

        static let deviceInstructions = "Enter this code at OpenAI"
        static let copy = "Copy"
        static let copied = "Copied"
        static let openOpenAI = "Open OpenAI"
        static let waiting = "Waiting for you to finish…"

        static let claudeInstructions = "Sign in to Claude in the browser, then paste the code it shows."
        static let openClaude = "Open Claude"
        static let code = "Code"
        static let connect = "Connect"
        static let useSetupToken = "Use a setup token instead"
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
