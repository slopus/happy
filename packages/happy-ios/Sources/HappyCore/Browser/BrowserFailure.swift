import Foundation
import Tailcat
#if canImport(Network)
import Network
#endif

enum BrowserProxyFailure: Error {
    case upstream(any Error)
    case responseStarted(any Error)
}

/// Safe, stable diagnostics: never stringify a URL, token, header or upstream
/// response body. API responses bypass this entirely, including 400/409/413.
struct BrowserFailure {
    let status: Int
    let reason: String
    let code: String

    init(_ error: any Error) {
        if case BrowserProxyFailure.responseStarted(let cause) = error { self.init(cause); return }
        if case BrowserProxyFailure.upstream(let cause) = error {
            if cause as? BrowserError == .timeout { self.init(504, "Gateway Timeout", "upstream_timeout") }
            else if cause as? BrowserError == .malformed || cause as? BrowserError == .tooLarge {
                self.init(502, "Bad Gateway", "upstream_response_invalid")
            } else if cause as? TailcatTransportError == .resourceLimit {
                self.init(503, "Service Unavailable", "upstream_capacity")
            } else { self.init(502, "Bad Gateway", "upstream_transport") }
            return
        }
        switch error {
        case BrowserError.forbidden: self.init(403, "Forbidden", "forbidden")
        case BrowserError.malformed: self.init(400, "Bad Request", "request_invalid")
        case BrowserError.tooLarge: self.init(413, "Content Too Large", "request_too_large")
        case BrowserError.unavailable: self.init(503, "Service Unavailable", "route_unavailable")
        case BrowserError.timeout: self.init(408, "Request Timeout", "request_timeout")
        case BrowserError.upstream(let status) where (400...599).contains(status):
            self.init(status, "Upstream Refused", "upstream_refused")
        case let transport as TailcatTransportError:
            self.init(transport == .resourceLimit ? 503 : 502, transport == .resourceLimit ? "Service Unavailable" : "Bad Gateway", transport == .resourceLimit ? "upstream_capacity" : "upstream_transport")
        default:
            #if canImport(Network)
            if error is NWError { self.init(502, "Bad Gateway", "socket_transport"); return }
            #endif
            self.init(500, "Internal Server Error", "internal")
        }
    }

    private init(_ status: Int, _ reason: String, _ code: String) {
        self.status = status; self.reason = reason; self.code = "browser_proxy_" + code
    }

    var data: Data {
        let body = Data("{\"code\":\"\(code)\",\"error\":\"\(reason)\"}".utf8)
        return Data("HTTP/1.1 \(status) \(reason)\r\nContent-Type: application/json\r\nX-Happy-Proxy-Error: \(code)\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n".utf8) + body
    }
}