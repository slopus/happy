#if canImport(Network)
import Foundation
import Network

/// Single resources (a document's pictures) fetched as the in-app browser
/// reaches the web: through the agent connection's workspace proxy, never
/// the phone's network, with no fallback. `https` goes through a loopback
/// `BrowserProxy` that URLSession uses as its CONNECT proxy, so TLS stays
/// end to end; plain `http` is one GET over a CONNECT tunnel, which keeps
/// App Transport Security (that refuses plain HTTP before any proxy) out
/// of it. Nothing is sent with a request but the request.
public actor BrowserFetcher {
    /// The largest body read; past it the fetch fails.
    public static let limit = 32 * 1024 * 1024
    static let redirects = 5

    private let client: AgentClient
    private let resolveWorkspace: @Sendable () async throws -> String
    private var workspace: Task<String, Error>?
    private var opening: Task<(URLSession, BrowserProxy), Error>?
    private var stopped = false

    /// `workspace` names the workspace whose network reaches the web,
    /// asked once, when the first resource is.
    public init(client: AgentClient, workspace: @escaping @Sendable () async throws -> String) {
        self.client = client
        resolveWorkspace = workspace
    }

    public func data(_ url: URL) async throws -> Data {
        try await data(url, redirects: Self.redirects)
    }

    private func data(_ url: URL, redirects: Int) async throws -> Data {
        guard !stopped else { throw CancellationError() }
        switch url.scheme?.lowercased() {
        case "https": return try await secure(url)
        case "http": return try await plain(url, redirects: redirects)
        default: throw BrowserError.forbidden
        }
    }

    /// Lets go of the proxy and its connections.
    public func stop() async {
        stopped = true
        opening?.cancel()
        if let (session, proxy) = try? await opening?.value {
            session.invalidateAndCancel()
            await proxy.stop()
        }
        opening = nil
    }

    private func workspaceID() async throws -> String {
        if let workspace { return try await workspace.value }
        let task = Task { try await resolveWorkspace() }
        workspace = task
        do { return try await task.value } catch {
            // Asked again next time: the computer may come back.
            workspace = nil
            throw error
        }
    }

    // MARK: https

    private func secure(_ url: URL) async throws -> Data {
        let (session, _) = try await proxied()
        let (data, response) = try await session.data(from: url)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw BrowserError.upstream((response as? HTTPURLResponse)?.statusCode ?? 502) }
        guard data.count <= Self.limit else { throw BrowserError.tooLarge }
        return data
    }

    private func proxied() async throws -> (URLSession, BrowserProxy) {
        if let opening { return try await opening.value }
        let client = client
        let task = Task { [self] () throws -> (URLSession, BrowserProxy) in
            let proxy = BrowserProxy(client: client, scope: .workspace(id: try await workspaceID()))
            let port = try await proxy.start()
            guard let endpointPort = NWEndpoint.Port(rawValue: port) else { await proxy.stop(); throw BrowserError.unavailable }
            var settings = ProxyConfiguration(httpCONNECTProxy: .hostPort(host: .ipv4(.loopback), port: endpointPort))
            settings.allowFailover = false
            settings.applyCredential(username: proxy.username, password: proxy.password)
            let configuration = URLSessionConfiguration.ephemeral
            configuration.proxyConfigurations = [settings]
            configuration.urlCache = nil
            configuration.httpCookieStorage = nil
            configuration.httpShouldSetCookies = false
            configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
            configuration.timeoutIntervalForRequest = 35
            let delegate = ProxyCredential(user: proxy.username, password: proxy.password)
            return (URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil), proxy)
        }
        opening = task
        do { return try await task.value } catch {
            opening = nil
            throw error
        }
    }

    /// Answers the loopback proxy's challenge, should URLSession not send
    /// the configuration's credential unasked; never any other challenge.
    private final class ProxyCredential: NSObject, URLSessionTaskDelegate, Sendable {
        let user: String
        let password: String
        init(user: String, password: String) { self.user = user; self.password = password }
        func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
            guard challenge.protectionSpace.isProxy(), challenge.protectionSpace.host == "127.0.0.1", challenge.previousFailureCount == 0 else { return (.performDefaultHandling, nil) }
            return (.useCredential, URLCredential(user: user, password: password, persistence: .forSession))
        }
    }

    // MARK: http

    private func plain(_ url: URL, redirects: Int) async throws -> Data {
        guard let authority = BrowserPolicy.Authority(url: url), let host = url.host,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { throw BrowserError.malformed }
        var target = components.percentEncodedPath.isEmpty ? "/" : components.percentEncodedPath
        if let query = components.percentEncodedQuery { target += "?" + query }
        guard !target.utf8.contains(where: { $0 < 33 || $0 == 127 }) else { throw BrowserError.malformed }
        let hostField = (host.contains(":") ? "[\(host)]" : host) + (url.port.map { ":\($0)" } ?? "")
        let stream = try await client.browserTunnel(workspaceID: try await workspaceID(), target: authority)
        let response: (status: Int, location: String?, body: Data)
        do {
            try await stream.write(Data("GET \(target) HTTP/1.1\r\nHost: \(hostField)\r\nAccept: image/*,*/*;q=0.8\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n".utf8))
            response = try await Self.read(stream)
            await stream.close()
        } catch {
            await stream.close()
            throw error
        }
        if [301, 302, 303, 307, 308].contains(response.status) {
            guard redirects > 0, let location = response.location, let next = URL(string: location, relativeTo: url)?.absoluteURL else { throw BrowserError.upstream(response.status) }
            return try await data(next, redirects: redirects - 1)
        }
        guard (200..<300).contains(response.status) else { throw BrowserError.upstream(response.status) }
        return response.body
    }

    /// One response, its body by its length, its chunks, or to the close.
    static func read(_ stream: any BrowserStream) async throws -> (status: Int, location: String?, body: Data) {
        let (head, rest) = try await BrowserRelay.head(stream)
        let parts = head.line.split(separator: " ")
        guard parts.count >= 2, parts[0].hasPrefix("HTTP/1."), let status = Int(parts[1]) else { throw BrowserError.malformed }
        let chunked = head.value("transfer-encoding")?.lowercased().contains("chunked") == true
        let length = chunked ? nil : head.value("content-length").flatMap { Int($0) }
        if let length, length > limit { throw BrowserError.tooLarge }
        var decoder = HTTP1BodyDecoder(chunked: chunked)
        var body = try decoder.append(rest)
        while !(chunked && decoder.finished), body.count < (length ?? .max) {
            try Task.checkCancellation()
            let bytes = try await stream.read(maximumBytes: 65536)
            if bytes.isEmpty {
                // Closed: the body is what came, unless more was promised.
                guard length == nil, !chunked else { throw BrowserError.malformed }
                break
            }
            body.append(try decoder.append(bytes))
            guard body.count <= limit else { throw BrowserError.tooLarge }
        }
        if let length { body = body.prefix(length) }
        return (status, head.value("location"), body)
    }
}
#endif
