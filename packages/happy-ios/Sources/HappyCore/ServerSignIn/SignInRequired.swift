import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// The edge SSO contract's one rule for "sign in again". A team server can
/// sit behind a load balancer that enforces SSO itself; what it answers in
/// the daemon's place is never Happy's JSON.
public enum SignInRequired {
    /// `Content-Type: application/json` (any parameters) and a JSON object
    /// whose `error` and `code` are strings: every daemon error has it.
    public static func isHappyError(contentType: String?, body: Data) -> Bool {
        guard let type = contentType?.split(separator: ";").first?.trimmingCharacters(in: .whitespaces).lowercased(),
              type == "application/json",
              let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else { return false }
        return object["error"] is String && object["code"] is String
    }

    /// Any redirect (a `3xx` other than `304`), any `401`, or a `403` that
    /// isn't Happy's JSON. A `403` with Happy's JSON is an ordinary
    /// permission error. Applies to WebSocket upgrades too.
    public static func check(status: Int, contentType: String?, body: Data) -> Bool {
        if ((300..<400).contains(status) && status != 304) || status == 401 { return true }
        return status == 403 && !isHappyError(contentType: contentType, body: body)
    }

    static func check(_ response: HTTP1Response) -> Bool {
        check(status: response.status, contentType: response.headers["content-type"], body: response.body)
    }
}

/// URLSession that never follows a redirect: the redirect itself comes back
/// as the response. Discovery and the token endpoint use it, so neither a
/// form with a refresh token nor a request is ever replayed to another URL.
public final class NoRedirectURLSessionTransport: NSObject, HTTPTransport, URLSessionTaskDelegate, @unchecked Sendable {
    private var session: URLSession!

    public override init() {
        super.init()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.timeoutIntervalForRequest = 35
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }

    deinit { session.finishTasksAndInvalidate() }

    public func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                           newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    public func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        var urlRequest = URLRequest(url: request.url)
        urlRequest.httpMethod = request.method
        urlRequest.httpBody = request.body
        for (name, value) in request.headers { urlRequest.setValue(value, forHTTPHeaderField: name) }
        let (data, response) = try await session.data(for: urlRequest)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        var headers: [String: String] = [:]
        for (name, value) in http.allHeaderFields {
            if let name = name as? String, let value = value as? String { headers[name.lowercased()] = value }
        }
        return HTTPResponse(status: http.statusCode, body: data, headers: headers)
    }
}
