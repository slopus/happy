import Foundation

/// Presentation only. Classify links after HappyCode has refused the input;
/// nothing here can open a link, start pairing, or validate credentials.
enum RejectedPairingLink: Equatable {
    case download
    case happyWebsite

    init?(_ text: String) {
        guard let url = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http",
              url.user == nil, url.password == nil, url.port == nil,
              let host = url.host?.lowercased() else { return nil }
        let path = url.percentEncodedPath.split(separator: "/")
        switch host {
        case "link.happy.engineering" where path == ["download"]:
            self = .download
        case "happy.engineering", "www.happy.engineering":
            self = path == ["download"] || (path.isEmpty && url.fragment == "download") ? .download : .happyWebsite
        case "testflight.apple.com" where path.count == 2 && path.first == "join":
            self = .download
        case "apps.apple.com", "itunes.apple.com":
            guard path.contains("app"), let last = path.last, last.hasPrefix("id") else { return nil }
            let id = last.dropFirst(2)
            guard !id.isEmpty, id.utf8.allSatisfy({ (48...57).contains($0) }) else { return nil }
            self = .download
        case "play.google.com" where path == ["store", "apps", "details"]:
            guard url.percentEncodedQuery?.split(separator: "&").contains(where: { $0.hasPrefix("id=") && $0.count > 3 }) == true else { return nil }
            self = .download
        case "app.happy.engineering", "link.happy.engineering":
            self = .happyWebsite
        default:
            return nil
        }
    }
}