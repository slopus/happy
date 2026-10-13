import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// The wire uses bearer tokens, not cookies. Default clients retain neither
/// responses nor cookies in process-wide or disk stores between accounts.
enum NetworkSession {
    static func make() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        return URLSession(configuration: configuration)
    }
}