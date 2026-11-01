import Foundation

/// Why the browser shows its error page instead of the page, worked out
/// from what WebKit, the agent proxy and the agent connection each say.
/// The classifiers return nil where nothing went wrong that a person needs
/// to hear about: a load that was cancelled or replaced by another.
public enum BrowserProblem: Equatable, Sendable {
    /// The phone has no network at all.
    case noNetwork
    /// The computer the page opens through isn't answering.
    case computerUnreachable
    /// There is no agent connection or route to open the page through.
    case unavailable
    /// The computer couldn't find the site's address.
    case hostNotFound
    /// The server on the computer refused the connection or isn't answering.
    case serverNotResponding
    /// The page took too long to answer.
    case timedOut
    /// A secure connection couldn't be made.
    case insecure
    /// The page answered with an error status and nothing to show.
    case http(status: Int)
    /// The page's web process stopped again after being reloaded once.
    case crashed
    /// A link to an app or scheme this phone has nothing to open with.
    case unsupported(scheme: String)
    /// Anything else, in the system's own words.
    case other(String)

    public static let webKitErrorDomain = "WebKitErrorDomain"
    /// WebKit's "frame load interrupted": a policy decision replaced the load.
    public static let frameLoadInterrupted = 102
    /// WebKit's "plug-in handled load": a download or a media document.
    public static let pluginHandledLoad = 204
    /// WebKit's "cannot show URL".
    public static let cannotShowURL = 101
    /// CFNetwork's refused proxy tunnel, HTTPS and SOCKS: the agent proxy
    /// answered CONNECT with an error status.
    public static let proxyRefusedCodes: Set<Int> = [310, 311]

    /// A load that never reached the page (`didFailProvisionalNavigation`)
    /// or broke off after it began (`didFail`). `refusal` is what the agent
    /// proxy last said for the page's host, if it refused the tunnel.
    public static func navigation(_ error: any Error, refusal: BrowserProxyRefusal?, link: LinkState?) -> BrowserProblem? {
        if isCancellation(error) { return nil }
        let error = error as NSError
        if link == .waitingForNetwork { return .noNetwork }
        if error.domain == NSURLErrorDomain, isSecurity(error.code) { return .insecure }
        if error.domain == NSURLErrorDomain, error.code == NSURLErrorUnsupportedURL
            || error.domain == webKitErrorDomain && error.code == cannotShowURL {
            let url = error.userInfo[NSURLErrorFailingURLErrorKey] as? URL
            return .unsupported(scheme: url?.scheme ?? "")
        }
        if link == .offline { return .computerUnreachable }
        if let refusal { return refusal.problem }
        if error.domain == NSURLErrorDomain {
            switch error.code {
            case NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed: return .hostNotFound
            case NSURLErrorCannotConnectToHost, NSURLErrorNetworkConnectionLost, NSURLErrorBadServerResponse: return .serverNotResponding
            case NSURLErrorTimedOut: return .timedOut
            case NSURLErrorNotConnectedToInternet, NSURLErrorInternationalRoamingOff, NSURLErrorDataNotAllowed: return .noNetwork
            default: break
            }
        }
        if error.domain == "kCFErrorDomainCFNetwork", proxyRefusedCodes.contains(error.code) { return .computerUnreachable }
        return .other(error.localizedDescription)
    }

    /// The main frame's response (`decidePolicyFor navigationResponse`).
    /// An error status with a body is the page's own error page and shows;
    /// one without has nothing to show. The agent proxy's own 502, 503 and
    /// 504 (`X-Happy-Proxy-Error`) mean the server behind it isn't
    /// answering, whatever its body says.
    public static func response(status: Int, proxyError: String?, hasBody: Bool, link: LinkState?) -> BrowserProblem? {
        guard status >= 400 else { return nil }
        if proxyError != nil {
            if link == .offline { return .computerUnreachable }
            if (502...504).contains(status) { return .serverNotResponding }
        }
        return hasBody && proxyError == nil ? nil : .http(status: status)
    }

    /// Opening the page failed before WebKit had it: finding the
    /// workspace, or starting the proxy.
    public static func opening(_ error: any Error, link: LinkState?) -> BrowserProblem {
        if link == .waitingForNetwork { return .noNetwork }
        if link == .offline { return .computerUnreachable }
        switch error {
        case is BrowserError, is AgentClientError: return .unavailable
        default: return .computerUnreachable
        }
    }

    public static func isCancellation(_ error: any Error) -> Bool {
        if error is CancellationError { return true }
        let error = error as NSError
        return (error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled)
            || (error.domain == webKitErrorDomain && [frameLoadInterrupted, pluginHandledLoad].contains(error.code))
    }

    private static func isSecurity(_ code: Int) -> Bool {
        [NSURLErrorSecureConnectionFailed, NSURLErrorServerCertificateHasBadDate, NSURLErrorServerCertificateUntrusted,
         NSURLErrorServerCertificateHasUnknownRoot, NSURLErrorServerCertificateNotYetValid, NSURLErrorClientCertificateRejected,
         NSURLErrorClientCertificateRequired, NSURLErrorAppTransportSecurityRequiresSecureConnection].contains(code)
    }
}

/// What the agent proxy answered instead of opening a tunnel to a page's
/// host (`BrowserFailure`), kept so the screen can say why: WebKit only
/// reports that the proxy refused.
public struct BrowserProxyRefusal: Equatable, Sendable {
    public let status: Int
    /// `browser_proxy_*`, as `X-Happy-Proxy-Error` carries it.
    public let code: String

    public init(status: Int, code: String) {
        self.status = status
        self.code = code
    }

    public var problem: BrowserProblem {
        switch code {
        case "browser_proxy_upstream_transport", "browser_proxy_socket_transport", "browser_proxy_upstream_capacity":
            return .computerUnreachable
        case "browser_proxy_upstream_timeout": return .timedOut
        case "browser_proxy_upstream_response_invalid": return .serverNotResponding
        case "browser_proxy_upstream_refused" where (502...504).contains(status): return .serverNotResponding
        default: return .unavailable
        }
    }
}

/// The agent proxy's refusals by host, newest kept, read by the screen
/// when WebKit says a load failed. Written from the proxy's connections,
/// read on the main thread.
public final class BrowserRefusals: @unchecked Sendable {
    private let lock = NSLock()
    private var byAuthority: [String: BrowserProxyRefusal] = [:]

    public init() {}

    func record(_ refusal: BrowserProxyRefusal, for authority: BrowserPolicy.Authority) {
        lock.lock(); defer { lock.unlock() }
        byAuthority[authority.text] = refusal
    }

    /// The last refusal for `url`'s host, if any since it was last cleared.
    public func last(for url: URL) -> BrowserProxyRefusal? {
        guard let authority = BrowserPolicy.Authority(url: url) else { return nil }
        lock.lock(); defer { lock.unlock() }
        return byAuthority[authority.text]
    }

    /// Forgets what was refused, before a new load of the page.
    public func clear() {
        lock.lock(); defer { lock.unlock() }
        byAuthority.removeAll()
    }
}
