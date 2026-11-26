import Foundation
import HappyCore

// Settings › Inference: a computer's Codex, Claude and Grok
// accounts and their sign-in. English only; the words are Android's,
// word for word.
extension Strings {
    enum ProviderAccounts {
        static let title = "Inference"
        static let accountsHeader = "Accounts"
        static let systemLogin = "Using system login"
        static let signedInToHappy = "Signed in to Happy"
        static let configured = "Configured in config file"
        static let signedOut = "Signed out"
        static let inProgress = "In progress"
        static let signInAgain = "Sign in again"
        static let updateToken = "Update token"
        static let footer = "Signing in here gives this account a login only Happy uses, so it stops using the system login."
        static let ownerOnly = "Only the team owner can change how accounts sign in."
        static let signsInOnComputer = "This account signs in on the computer, not from a phone."
        static let empty = "No accounts sign in with a subscription."
        static let noAccounts = "No accounts"
        static let allOff = "Every account on this \(AccountKind.agent) is switched off."
        static let loadFailed = "Couldn’t load the accounts."

        /// The credential line under an account's name.
        static func credential(_ source: ProviderCredential.Source, account: ProviderSignIn.Account?) -> String {
            switch source {
            case .system: return systemLogin
            case .configured: return configured
            case .internal:
                return ([signedInToHappy] + [account?.email, account?.plan].compactMap { $0?.isEmpty == false ? $0 : nil }).joined(separator: " · ")
            }
        }

        /// The vendor's program that signs `cli` in.
        static func program(_ cli: String) -> String {
            switch cli {
            case "codex": "Codex"
            case "claude": "Claude Code"
            case "grok": "Grok"
            default: cli
            }
        }

        static func notInstalled(_ cli: String) -> String { "Install \(program(cli)) on the computer to sign in." }

        // The list's rows: a line under the name, the first that applies.
        static let off = "Off"
        static let systemPrefix = "System login"
        static let notUsedYet = "Not used yet"

        /// The row's one line. `expires`, while renewing fails and the login
        /// runs out within a day, takes the place of when it was last tried.
        static func status(_ status: ProviderAccountStatus, source: ProviderCredential.Source, account: ProviderSignIn.Account?, expires: Date? = nil, now: Date) -> String {
            switch status {
            case .off:
                return off
            case .needsSignIn(let since):
                return since.map { "Needs sign-in since \(shortDate($0))" } ?? "Needs sign-in"
            case .refreshFailed(let reason, let at):
                let when = expires.map { $0 <= now ? "login expired" : "expires in \(span($0.timeIntervalSince(now)))" } ?? "last tried \(ago(at, now: now))"
                return (["Couldn’t refresh"] + [reason].compactMap { $0 } + [when]).joined(separator: " · ")
            case .working(_, let system, let used, let refreshed, let checked):
                var parts: [String] = []
                switch used {
                case .never: parts.append(notUsedYet)
                case .at(let date): parts.append("Used \(ago(date, now: now))")
                case nil: break
                }
                if let refreshed { parts.append("refreshed \(ago(refreshed, now: now))") }
                if let checked, parts.isEmpty { parts.append("Last checked \(ago(checked, now: now))") }
                if system { return ([systemPrefix] + parts).joined(separator: " · ") }
                return parts.isEmpty ? credential(source, account: account) : parts.joined(separator: " · ")
            }
        }

        /// "just now", "4m ago", "3h ago", "2d ago".
        static func ago(_ at: Date, now: Date) -> String {
            let seconds = now.timeIntervalSince(at)
            return seconds < 60 ? "just now" : "\(span(seconds)) ago"
        }

        /// "4m", "3h", "2d".
        static func span(_ seconds: TimeInterval) -> String {
            let minutes = max(1, Int(seconds / 60))
            if minutes < 60 { return "\(minutes)m" }
            if minutes < 24 * 60 { return "\(minutes / 60)h" }
            return "\(minutes / (24 * 60))d"
        }

        static func shortDate(_ date: Date) -> String {
            date.formatted(.dateTime.month(.abbreviated).day())
        }

        // An account's own page.
        static let vendor = "Vendor"
        static let enabled = "Enabled"
        static let loginHeader = "Login"
        static let source = "Source"
        static let lastUsed = "Last used"
        static let lastRefresh = "Last refresh"
        static let tokenExpires = "Token expires"
        static let lastRefreshError = "Last refresh error"
        /// A value the computer doesn't know, or an error there isn't.
        static let unknown = "—"
        // The sign-in row's value while it can't be used here.
        static let ownerOnlyShort = "Owner only"
        static let notInstalledShort = "Not installed"
        static let onComputerShort = "On the computer"
        static let couldNotSwitch = "Couldn’t change the account"

        static func refreshError(_ error: ProviderAccountHealth.RefreshError) -> String {
            ([error.reason] + ["since \(shortDate(error.since))"]).compactMap { $0 }.joined(separator: " · ")
        }

        static func expiry(_ at: Date, now: Date) -> String {
            at <= now ? "Expired" : "In \(span(at.timeIntervalSince(now)))"
        }

        // The sign-in page.
        static let starting = "Starting the sign-in…"
        static let deviceInstructions = "Enter this code on the sign-in page"
        static let browserInstructions = "Open the sign-in page, then paste the code it shows."
        static let finishOnComputerTitle = "Finish on the computer"
        static let finishOnComputer = "This sign-in finishes in a browser on the computer. Finish it there, or cancel it."
        static let openPage = "Open sign-in page"
        static let codePlaceholder = "Paste the code"
        static let submitCode = "Continue"
        static let waiting = "Waiting for you to finish…"
        static let checking = "Checking…"
        static let signedIn = "Signed in"
        static let done = "Done"
        static let signInFailed = "Sign-in failed"
        static let signInExpired = "Sign-in expired"
        static let saveFailed = "Couldn’t save the sign-in"
        static let keptLogin = "The account keeps the login it had."
        static let tryAgain = "Try again"
        static let close = "Close"

        /// A failed sign-in's title, by its code.
        static func failure(_ code: String?) -> String {
            switch code {
            case "expired": signInExpired
            case "save_failed": saveFailed
            default: signInFailed
            }
        }

        // Update token.
        static let tokenMessage = "Paste a token from `claude setup-token` on your computer."
        static let tokenPlaceholder = "Setup token"
        static let save = "Save"
        static let tokenSaved = "Token updated"
        static let tokenFailed = "Couldn’t update the token"
    }
}
