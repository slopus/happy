import Foundation
import HappyCore

// A Happy Cloud server's onboarding: the screens its gates ask for.
extension Strings {
    enum CloudOnboarding {
        static let notNow = "Not Now"
        static let skip = "Skip for Now"
        static let checkAgain = "Check Again"
        static let couldntSkip = "Couldn’t skip this step. Try again."
        static let couldntCheck = "Couldn’t reach the server. Try again."

        static let photoTitle = "Add a photo"
        static let photoBody = "Your team and agents see it next to your name."
        static let choosePhoto = "Choose Photo"
        static let photoFailed = "Your photo didn’t upload. Try again."

        static let botTitle = "Name your admin bot"
        static let botBody = "This is your server’s admin bot. It can change the server’s settings, connect tools and create other bots, so it can adapt Happy and build a system around how your team works."
        static let botNamePlaceholder = "Its name"
        static let botNameFailed = "Couldn’t save the name. Try again."

        static let updateTitle = "Update Happy to continue"
        static let updateBody = "This server asks for a step this version of Happy doesn’t know yet."
        static let updateAction = "Open the App Store"

        static let waitingTitle = "Waiting for your admin"
        static func waitingBody(_ steps: [String]) -> String {
            "Someone who manages this server has to finish setting it up first: \(ListFormatter.localizedString(byJoining: steps.map(\.lowercasedFirst)))."
        }
        static let notReadyTitle = "Almost ready"
        static let notReadyBody = "This server isn’t ready for you yet. Check again in a little while."

        static let elsewhereTitle = "Finish on the web"
        static func elsewhereBody(_ step: String) -> String {
            "\(step) is done in Happy on your computer or on the web. Come back here when it’s done."
        }
        static let openWeb = "Open on the Web"

        static let doneTitle = "You’re all set"
        static func doneBody(_ handle: String) -> String { "\(handle) is ready for you." }
        static func meet(_ name: String) -> String { "Meet \(name)" }
        static let getStarted = "Get Started"
        static let couldntFinish = "Couldn’t finish setting up. Try again."

        /// A gate, as a step in a sentence.
        static func step(_ gate: OnboardingGate) -> String {
            switch gate.kind {
            case .profile: "Your name"
            case .avatar: "Your photo"
            case .adminBot: "Naming the admin bot"
            case .inference: "Connecting a model provider"
            case .plugins: "Connecting plugins"
            case .teammates: "Inviting teammates"
            case .mobileApp: "Installing the mobile app"
            case .paymentMethod: "Adding a payment method"
            case .payment: "Paying for this server"
            case .unknown: "A new step"
            }
        }
    }
}

private extension String {
    var lowercasedFirst: String { prefix(1).lowercased() + dropFirst() }
}
