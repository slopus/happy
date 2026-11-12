import Foundation
import HappyCore

// Happy Cloud's sign-in by a code sent by email: this app's own words.
// English only, as the rest of Happy Cloud's are.
extension Strings {
    enum CloudEmail {
        /// The welcome's third way in, under GitHub's.
        static let action = "Continue with email"

        static let emailTitle = "Sign in with email"
        static let emailMessage = "We’ll email you a code to sign in or create your Happy Cloud account."
        static let emailPlaceholder = "you@example.com"
        static let send = "Send code"
        static let emailMissing = "Enter your email address."

        static let codeTitle = "Check your email"
        static func codeMessage(_ email: String) -> String { "Enter the 6-digit code we sent to \(email)." }
        static let codePlaceholder = "6-digit code"
        static let verify = "Verify"
        static let resend = "Resend code"
        static let resent = "We sent a new code."
        static let changeEmail = "Change email"

        static func send(in seconds: TimeInterval) -> String { "Send code in \(clock(seconds))" }
        static func verify(in seconds: TimeInterval) -> String { "Verify in \(clock(seconds))" }
        static func resend(in seconds: TimeInterval) -> String { "Resend code in \(clock(seconds))" }

        static let invalidEmail = "Enter a valid email address."
        static let invalidCode = "That code didn’t work."
        static let unsupported = "Email sign-in isn’t available yet. Sign in with Apple or GitHub."
        static let unavailable = "Happy Cloud couldn’t send or check codes just now. Try again in a moment."
        static let rateLimited = "Too many tries. Wait a moment and try again."

        /// Why sending or checking a code failed. Email sign-in not set up
        /// on the accounts service says so in the app's words; the rest
        /// are the service's own, or ours when it gives none.
        static func failure(_ error: any Error) -> String {
            switch error {
            case CloudAccountError.refused(_, "unsupported_provider", _): return unsupported
            case CloudAccountError.rateLimited(_, let message): return message ?? rateLimited
            case CloudAccountError.refused(_, "invalid_code", nil): return invalidCode
            case CloudAccountError.refused(_, "invalid_email", nil): return invalidEmail
            case CloudAccountError.refused(_, "unavailable", nil): return unavailable
            default: return HappyCloud.failure(error)
            }
        }

        /// A wait as minutes and seconds, `0:42`, rounded up.
        static func clock(_ seconds: TimeInterval) -> String {
            let whole = max(0, Int(seconds.rounded(.up)))
            return "\(whole / 60):" + String(format: "%02d", whole % 60)
        }
    }
}
