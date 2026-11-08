import Foundation

extension Strings {
    /// The first screen. Not in happy-app's catalogs; English only, as
    /// Android's are.
    public enum Start {
        public static let logo = "Happy"
        public static let button = "Start"
        public static let more = "More"
        /// Beside Start: Happy Cloud needs no computer.
        public static let cloud = "Use Happy Cloud"
        public static let enterLink = "Enter link manually"
        public static let enterLinkTitle = "Enter Link"
        public static var enterLinkMessage: String { AccountKind.enterLinkMessage }
        /// A slide's animation, as desktop's deck labels its replay (WelcomeDeck.tsx).
        public static func replay(_ title: String) -> String { "Play the \(title) animation again" }

        /// happy-desktop's welcome deck (happy-desktop-app
        /// sources/onboarding/happyAgentWelcomeSlides.ts): its titles as
        /// they are, each line cut down to its first words for a phone.
        /// "Secure and compliant" is left out, as desktop left it out
        /// (its "No telemetry" no longer holds), and "harness" reads "app"
        /// (Steve). No-break spaces hold each short sentence of a title
        /// together, so a title breaks only between them.
        /// The screen after Start (Kirill's words): where desktop offers
        /// this phone its code, during its onboarding or later in its
        /// settings, and where to get it. Desktop's own names for the two.
        public static let installChoose = "Choose Link\u{00A0}Mobile\u{00A0}App during onboarding."
        public static let installSettings = "Or go to Settings\u{00A0}›\u{00A0}Mobile\u{00A0}Access."
        public static let installDownloadPrefix = "Download from "

        public static let slides: [(title: String, body: String)] = [
            ("Any\u{00A0}model. Your\u{00A0}team. One\u{00A0}app.", "Happy integrates models, teams, and compute into one open-source app."),
            ("Natively multiplayer", "Bring your team into one session with every agent."),
            // A word joiner keeps the dash on review's line.
            ("One\u{00A0}app. Every\u{00A0}agent.", "Let Claude plan, Codex build, and Grok review\u{2060}—or run them side by side."),
            ("Yours\u{00A0}to\u{00A0}run. Yours\u{00A0}to\u{00A0}change.", "Run it on your hardware, in your cloud, or in ours."),
        ]
    }
}
