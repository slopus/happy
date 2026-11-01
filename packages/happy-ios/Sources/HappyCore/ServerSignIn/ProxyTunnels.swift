import Foundation
import HappyWire

/// How an HTTPS server's proxy tunnels open (edge SSO contract §4), learned
/// once per origin for the app's lifetime so a blocked server isn't tried
/// again and again:
///
/// - `webSocket` when health reports `capabilities.webSocketTunnels`;
/// - otherwise CONNECT, until something in front of the daemon refuses it
///   (an answer that isn't Happy's JSON, or a dropped connection), which
///   makes it `blocked`: previews say so instead of retrying.
final class TunnelSupport: @unchecked Sendable {
    enum Mode: Equatable, Sendable { case webSocket, connect, blocked }

    static let shared = TunnelSupport()
    private let lock = NSLock()
    private var modes: [String: Mode] = [:]

    func mode(_ origin: String) -> Mode? { lock.withLock { modes[origin] } }

    func set(_ mode: Mode, for origin: String) {
        lock.withLock {
            // Blocked stays blocked until the app starts again.
            guard modes[origin] != .blocked else { return }
            modes[origin] = mode
        }
    }

    func forget() { lock.withLock { modes.removeAll() } }
}

extension AgentHTTPTransport {
    /// Over Tailcat the tunnel is CONNECT to the daemon itself. Over HTTPS
    /// it goes through whatever fronts the daemon, so it is the WebSocket
    /// twin when the daemon has one.
    public func proxyTunnel(_ path: String, credential: String) async throws -> any BrowserStream {
        guard let publicUrl else { return try await connectTunnel(path, credential: credential) }
        let origin = try AgentOrigin(publicUrl).value
        let support = TunnelSupport.shared
        var mode = support.mode(origin)
        if mode == nil {
            mode = try await webSocketTunnels(credential: credential) ? .webSocket : .connect
            support.set(mode!, for: origin)
            mode = support.mode(origin)
        }
        switch mode {
        case .blocked: throw BrowserError.tunnelsBlocked
        case .webSocket: return try await webSocketTunnel(path, credential: credential, origin: origin)
        default: return try await publicConnectTunnel(path, credential: credential, origin: origin)
        }
    }

    /// `capabilities.webSocketTunnels` from health.
    private func webSocketTunnels(credential: String) async throws -> Bool {
        let response = try await request(method: "GET", path: "/v0/health", credential: credential, body: nil, headers: [:], category: .query)
        if SignInRequired.check(response) {
            throw TunnelRefusal(status: response.status, contentType: response.headers["content-type"], body: response.body)
        }
        guard response.status == 200 else { throw BrowserError.unavailable }
        struct Health: Decodable { struct Capabilities: Decodable { let webSocketTunnels: Bool? }; let capabilities: Capabilities? }
        return (try? JSONDecoder().decode(Health.self, from: response.body))?.capabilities?.webSocketTunnels == true
    }

    private func webSocketTunnel(_ path: String, credential: String, origin: String) async throws -> any BrowserStream {
        let stream = try await browserConnection()
        do {
            return try await WebSocketTunnel.open(stream, path: path + "/websocket", credential: credential)
        } catch let refusal as TunnelRefusal {
            throw Self.classify(refusal, origin: origin)
        } catch {
            await stream.close()
            throw error
        }
    }

    /// CONNECT through the server's edge, telling its refusal apart from
    /// the daemon's.
    private func publicConnectTunnel(_ path: String, credential: String, origin: String) async throws -> any BrowserStream {
        let stream = try await browserConnection()
        do {
            try await stream.write(Data("CONNECT \(path) HTTP/1.1\r\nHost: \(stream.authority)\r\nAuthorization: Bearer \(credential)\r\n\r\n".utf8))
            let head: BrowserHTTPHead, rest: Data
            do { (head, rest) = try await BrowserRelay.head(stream) }
            catch is CancellationError { throw CancellationError() }
            catch {
                // Dropped without an answer: the edge doesn't carry CONNECT.
                TunnelSupport.shared.set(.blocked, for: origin)
                throw BrowserError.tunnelsBlocked
            }
            let status = Int(head.line.split(separator: " ").dropFirst().first ?? "") ?? 0
            guard status == 200, rest.isEmpty else {
                var body = rest
                if let length = head.value("content-length").flatMap(Int.init), length <= 65536 {
                    while body.count < length, let bytes = try? await stream.read(maximumBytes: 65536), !bytes.isEmpty { body.append(bytes) }
                }
                throw Self.classify(TunnelRefusal(status: status, contentType: head.value("content-type"), body: body), origin: origin)
            }
            return stream
        } catch {
            await stream.close()
            throw error
        }
    }

    /// A refusal that needs signing in goes up as it is; the daemon's own
    /// is an ordinary upstream answer; anything else is the edge refusing
    /// tunnels.
    static func classify(_ refusal: TunnelRefusal, origin: String) -> any Error {
        if refusal.requiresSignIn { return refusal }
        if refusal.isHappyError { return BrowserError.upstream(refusal.status) }
        TunnelSupport.shared.set(.blocked, for: origin)
        return BrowserError.tunnelsBlocked
    }
}
