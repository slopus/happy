import Foundation
import HappyCore

extension Strings {
    /// The Happy CLI home's migration card and the screen it opens, on
    /// either path (`MigrationPath`), in Kirill's words. Not in happy-app's
    /// catalogs: every language's are in `TranslationCatalog.nativeSources`
    /// (`desktopMigrationSources`). Happy Desktop, Happy Agent, Chief of
    /// Staff and desktop's own Settings › Mobile Access keep their names.
    public enum DesktopMigration {
        public static var close: String { localized("native.desktopMigration.close", "Close") }

        /// A Happy CLI account with no Happy Agent: move to Happy Desktop.
        public static var desktopTitle: String { localized("native.desktopMigration.desktopTitle", "Happy now on desktop") }
        public static var desktopBody: String {
            localized("native.desktopMigration.desktopBody", "Multiplayer for remote servers, lower latency, better attachment support and much more. Please migrate! It takes around 5 minutes, a bit longer if you have several machines.")
        }
        /// The steps, in the first-run screen's words (`Strings.Onboarding`,
        /// `Strings.Start`), then a server's case; Scan QR code, its button,
        /// ends both paths.
        public static var desktopSteps: [Step] {
            [
                Step(text: Onboarding.offlineOpenStep, link: Start.installDownloadPrefix + Onboarding.installBodyLink),
                Step(text: "\(Start.installChoose)\n\(Start.installSettings)", link: nil),
                Step(text: serverStep, link: nil, detail: serverStepDetail),
            ]
        }

        /// Happy Agent already, reached through the Happy server: connect
        /// to it directly.
        public static var agentConnectionTitle: String { localized("native.desktopMigration.agentConnectionTitle", "Migrate to direct connection") }
        public static var agentConnectionBody: String {
            localized("native.desktopMigration.agentConnectionBody", "You’re using Happy Agent through the Happy server. Connect directly for the lowest latency and newest features.")
        }
        /// Happy Desktop is set up already, so its onboarding is past: only
        /// its settings, as the first-run screen names them, then a
        /// server's case.
        public static var agentConnectionSteps: [Step] {
            [
                Step(text: Onboarding.offlineOpenStep, link: nil),
                Step(text: localized("native.desktopMigration.settingsStep", "Go to Settings\u{00A0}›\u{00A0}Mobile\u{00A0}Access."), link: nil),
                Step(text: serverStep, link: nil, detail: serverStepDetail),
            ]
        }

        /// A Happy Agent on a server is picked in Happy Desktop and scanned
        /// the same way; Chief of Staff sets up a new one.
        public static var serverStep: String { localized("native.desktopMigration.serverStep", "Using Happy on a server?") }
        public static var serverStepDetail: String {
            localized("native.desktopMigration.serverStepDetail", "Select it in Happy Desktop and scan its code.\nTo set up a new remote server, just ask the Chief of Staff bot in Happy Desktop.")
        }

        public struct Step {
            public var text: String
            /// The site, under the step, as the first-run screen offers it.
            public var link: String?
            /// Words under the step, in the site's place and type.
            public var detail: String? = nil
        }

        /// The first-run screen's button, which opens the scanner.
        public static var scan: String { Onboarding.scanButton }
        public static var learnMore: String { localized("native.desktopMigration.learnMore", "Learn more") }
        public static let learnMoreURL = URL(string: "https://happy.engineering/migrate")!
    }
}
