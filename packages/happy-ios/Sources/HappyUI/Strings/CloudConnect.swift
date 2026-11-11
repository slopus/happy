import Foundation
import HappyCore

// Happy Cloud's welcome and its steps, as happy-desktop's CloudConnectScreen
// says them (happy-desktop dca9b205, packages/happy-desktop-ui/src/
// CloudConnectScreen.tsx), word for word; Android's are the same. English
// only, as the first screen's are.
extension Strings {
    enum CloudConnect {
        /// Desktop's CLOUD_SLIDES: what Happy Cloud is, then what its plan
        /// promises.
        static let slides: [(title: String, body: String)] = [
            ("Happy Cloud", "A hardened, high-performance control plane for your agents, hosted by Happy."),
            ("Built for lots of agents", "Happy Cloud helps you unlock running any number of agents, unattended."),
            ("Programmable permissions", "Decide what every agent can see and do, and keep each one isolated."),
            ("No lock-in", "Never locked into someone else's compute. Use ours or yours, and source tokens and RAM from anywhere."),
            ("Private open source", "We share every line of Happy Cloud with select customers and security companies to review."),
        ]
        static let continueAction = "Continue"
        /// Over the sign-in buttons when the account's hour-long sign-in
        /// has ended.
        static let expired = "Your Happy Cloud sign-in has ended. Sign in again."

        /// The welcome's second way in, under Apple's own button.
        static let github = "Sign in with GitHub"
        /// A test account's sign-in.
        static let signInTitle = "Sign in"

        static let serversTitle = "Join a server"
        static let serversMessage = "Your account is already on these servers. Join as many as you like."
        static let join = "Join"
        static let joined = "Joined"
        static func joinServer(_ name: String) -> String { "Join \(name)" }
        static let bootstrapNew = "Bootstrap a new one"
        static let joinWithInvite = "Join with an invite"

        static let createTitle = "Bootstrap a server"
        static let createMessage = "Name your team’s new server. You can change it later."
        static let createFirstMessage = "Your account has no servers yet. Name your team’s first one."
        static let createAction = "Bootstrap"
        static let haveInvite = "Have an invite? Join a server"
        static let namePlaceholder = "acme"
        static let checking = "Checking…"
        static let invalidName = "3–32 lowercase letters, digits or dashes, not starting or ending with a dash."
        static func available(_ name: String) -> String { "\(HappyCore.HappyCloud.handle(name)) is available" }

        static func unavailable(_ availability: CloudAccount.Availability, name: String) -> String? {
            switch availability {
            case .available: return nil
            case .taken: return "\(HappyCore.HappyCloud.handle(name)) is taken."
            case .reserved: return "\(HappyCore.HappyCloud.handle(name)) is reserved."
            case .invalid: return invalidName
            }
        }

        static let joinTitle = "Join with an invite"
        static let joinMessage = "Enter the server’s name and the invite code you were sent."
        static let joinAction = "Join server"
        static let codePlaceholder = "Invite code"

        static let failedTitle = "Couldn’t connect"
    }
}
