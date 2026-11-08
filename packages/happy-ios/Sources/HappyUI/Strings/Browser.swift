import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import HappyCore

// The in-app browser has no screen in happy-app; these are this app's own,
// in Safari's words where Safari says the same thing.
extension Strings {
    enum Browser {
        static let back = "Back"
        static let forward = "Forward"
        static let reload = "Reload"
        static let stop = "Stop"
        static let share = "Share"
        static let shareLink = "Share…"
        static let copyLink = "Copy Link"
        static let openInSafari = "Open in Safari (outside proxy)"
        static let tryAgain = "Try Again"
        static let cantOpenLink = "Can’t Open This Link"

        /// The error page's title and the sentence under it. `computer` is
        /// the agent connection's name; `host` the page's host.
        static func failure(_ problem: BrowserProblem, computer: String, host: String?) -> (title: String, message: String) {
            let site = host.map { "“\($0)”" } ?? "the server"
            switch problem {
            case .noNetwork:
                return ("You’re Offline", "This iPhone isn’t connected to the internet. Pages open once it is.")
            case .computerUnreachable:
                return ("Can’t Reach \(computer)", "Pages open through \(computer), and it isn’t answering. Make sure it’s awake and Happy is running there.")
            case .unavailable:
                return ("Can’t Open This Page", "Pages open through a computer running Happy Agent, and there’s no connection to open this one through.")
            case .liveUnavailable:
                return ("This Page’s Computer Isn’t Available", "This page runs on the computer where the agent that shared it works. That computer isn’t available right now, or the page is no longer shared.")
            case .hostNotFound:
                return ("Can’t Find the Server", "\(computer) couldn’t find \(site). Check the address.")
            case .serverNotResponding:
                return ("Server Isn’t Responding", "The server on your computer at \(site) isn’t responding. Make sure it’s running, then try again.")
            case .timedOut:
                return ("Page Took Too Long", "\(site.prefix(1).uppercased() + site.dropFirst()) didn’t answer in time.")
            case .insecure:
                return ("Can’t Open Securely", "A secure connection to \(site) couldn’t be made.")
            case .http(let status):
                return ("Page Error \(status)", "The server answered “\(HTTPURLResponse.localizedString(forStatusCode: status).capitalized)” with nothing to show.")
            case .crashed:
                return ("This Page Stopped Working", "A problem kept happening while it loaded. Try opening it again.")
            case .unsupported(let scheme):
                return (cantOpenLink, scheme.isEmpty ? "No app on this iPhone opens this link." : "No app on this iPhone opens “\(scheme):” links.")
            case .tunnelsBlocked:
                return ("Previews Aren’t Available", "This server’s network doesn’t allow previews. Ask your administrator to allow WebSocket connections to Happy.")
            case .signInRequired:
                return ("Sign In Again", "Your sign-in to \(computer) has ended. Sign in again from Settings to open pages through it.")
            case .other(let description):
                return ("Can’t Open This Page", description)
            }
        }
    }
}
