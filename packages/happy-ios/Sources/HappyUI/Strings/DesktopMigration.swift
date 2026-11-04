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
        /// `Strings.Start`); Scan QR code, its button, ends both paths.
        public static var desktopSteps: [Step] {
            [
                Step(text: Onboarding.offlineOpenStep, link: Start.installDownloadPrefix + Onboarding.installBodyLink),
                Step(text: "\(Start.installChoose)\n\(Start.installSettings)", link: nil),
            ]
        }

        /// Happy Agent already, reached through the Happy server: connect
        /// to it directly.
        public static var agentConnectionTitle: String { localized("native.desktopMigration.agentConnectionTitle", "Migrate to direct connection") }
        public static var agentConnectionBody: String {
            localized("native.desktopMigration.agentConnectionBody", "You’re using Happy Agent through the Happy server. Connect directly for the lowest latency and newest features.")
        }
        /// Happy Desktop is set up already, so its onboarding is past: only
        /// its settings, as the first-run screen names them.
        public static var agentConnectionSteps: [Step] {
            [
                Step(text: Onboarding.offlineOpenStep, link: nil),
                Step(text: localized("native.desktopMigration.settingsStep", "Go to Settings\u{00A0}›\u{00A0}Mobile\u{00A0}Access."), link: nil),
            ]
        }

        public struct Step {
            public var text: String
            /// The site, under the step, as the first-run screen offers it.
            public var link: String?
        }

        /// The first-run screen's button, which opens the scanner.
        public static var scan: String { Onboarding.scanButton }
        public static var learnMore: String { localized("native.desktopMigration.learnMore", "Learn more") }
        public static let learnMoreURL = URL(string: "https://happy.engineering/migrate")!
        public static var serverTitle: String { localized("native.desktopMigration.serverTitle", "Running Happy on a server?") }
        public static var serverParagraphs: [String] {
            [
                localized("native.desktopMigration.serverScan", "In Happy Desktop, select the remote server and scan its code the same way."),
                localized("native.desktopMigration.serverSetUp", "To set up a new server, ask Chief of Staff."),
            ]
        }

        /// The current connection and the one after migration. Both pass
        /// through something; only the Happy server keeps anything.
        public static var current: String { localized("native.desktopMigration.current", "Current connection") }
        public static var after: String { localized("native.desktopMigration.after", "After migration") }
        public static var phone: String { localized("native.desktopMigration.phone", "Phone") }
        public static var computer: String { localized("native.desktopMigration.computer", "Computer") }
        public static var server: String { localized("native.desktopMigration.server", "Happy server") }
        public static var serverDetail: String { localized("native.desktopMigration.serverDetail", "Stores your chats, encrypted") }
        public static var relay: String { localized("native.desktopMigration.relay", "Relay") }
        public static var relayDetail: String { localized("native.desktopMigration.relayDetail", "Passes through, still encrypted") }
        public static var diagramSpoken: String {
            localized("native.desktopMigration.diagramSpoken", "Current connection: your phone reaches your computer through the Happy server, which stores your chats, encrypted. After migration: your phone reaches your computer through a relay, which passes them through, still encrypted.")
        }
    }
}
