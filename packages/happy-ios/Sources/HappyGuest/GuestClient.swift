import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Isolated transport: no owner token, recovery key, account store, or RPC.
public actor GuestClient {
    private let origin: URL
    private let transport: URLSession
    private var seenMessageIDs: Set<String> = []

    public init(origin: URL) {
        self.origin = origin
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 35
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        self.transport = URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
    }

    init(origin: URL, transport: URLSession) {
        self.origin = origin
        self.transport = transport
    }

    deinit { transport.invalidateAndCancel() }

    public func redeem(_ invitation: GuestInvitation, redeemNonce: String, displayName: String) async throws -> GuestSession {
        guard let displayName = GuestDisplayName.normalized(displayName) else { throw GuestError.invalidName }
        struct Request: Encodable { let token: String; let redeemNonce: String; let displayName: String }
        let session: GuestSession = try await request(path: ["v1", "bot-invites", "redeem"], body: JSONEncoder().encode(Request(token: invitation.token, redeemNonce: redeemNonce, displayName: displayName)))
        guard Self.validSessionID(session.sessionId), !session.sessionToken.isEmpty else { throw GuestError.invalidResponse }
        return session
    }

    public func messages(session: GuestSession, after: String?) async throws -> GuestMessages {
        guard Self.validSessionID(session.sessionId) else { throw GuestError.invalidResponse }
        return try await request(path: ["v1", "bot-guest", "sessions", session.sessionId, "messages"], token: session.sessionToken, after: after)
    }

    public func send(session: GuestSession, localId: String, text: String) async throws {
        guard Self.validSessionID(session.sessionId) else { throw GuestError.invalidResponse }
        guard !text.isEmpty, text.utf16.count <= 4_000 else { throw GuestSendRejection.invalidMessage }
        struct Request: Encodable { let localId: String; let text: String }
        let _: EmptyReply = try await request(path: ["v1", "bot-guest", "sessions", session.sessionId, "messages"],
                                              token: session.sessionToken, body: JSONEncoder().encode(Request(localId: localId, text: text)), sending: true)
    }

    public func report(session: GuestSession) async throws { try await action("report", session: session) }
    public func block(session: GuestSession) async throws { try await action("block", session: session) }

    private func action(_ action: String, session: GuestSession) async throws {
        guard Self.validSessionID(session.sessionId) else { throw GuestError.invalidResponse }
        let _: EmptyReply = try await request(path: ["v1", "bot-guest", "sessions", session.sessionId, action],
                                             token: session.sessionToken, body: Data("{}".utf8))
    }

    private static func validSessionID(_ id: String) -> Bool {
        (1...128).contains(id.utf8.count) && id.utf8.allSatisfy {
            (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95
        }
    }

    /// Deduplication and text derivation stay off the UI actor. The view appends
    /// only this delta rather than replacing the transcript every poll.
    public func append(_ messages: [GuestMessage], botName: String) -> String {
        messages.compactMap { message -> String? in
            guard seenMessageIDs.insert(message.id).inserted else { return nil }
            let sender: String
            switch message.role {
            case .assistant: sender = botName
            case .user: sender = message.isMine == false ? (message.senderName ?? "Member") : "You"
            }
            return sender + "\n" + message.text
        }.joined(separator: "\n\n")
    }

    private struct EmptyReply: Decodable {}
    private struct ErrorBody: Decodable { let code: String? }

    private func request<T: Decodable>(path: [String], token: String? = nil, after: String? = nil, body: Data? = nil, sending: Bool = false) async throws -> T {
        var url = origin
        for component in path { url.appendPathComponent(component) }
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { throw GuestError.invalidResponse }
        if body == nil {
            components.queryItems = [.init(name: "wait", value: "25")]
            if let after { components.queryItems?.append(.init(name: "after", value: after)) }
        }
        guard let endpoint = components.url else { throw GuestError.invalidResponse }
        var request = URLRequest(url: endpoint)
        request.httpMethod = body == nil ? "GET" : "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await transport.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw GuestError.invalidResponse }
        switch response.statusCode {
        case 200..<300: break
        case let status where sending && [400, 409, 413, 422].contains(status): throw GuestSendRejection.invalidMessage
        case 400 where !sending && (try? JSONDecoder().decode(ErrorBody.self, from: data).code) == "invalid_name": throw GuestError.invalidName
        case 409: throw GuestError.alreadyRedeemed
        case 401, 404: throw GuestError.revoked
        case 403: throw GuestError.readOnly
        case 410:
            if (try? JSONDecoder().decode(ErrorBody.self, from: data).code) == "invite_full" { throw GuestError.inviteFull }
            throw GuestError.expired
        case 429, 503:
            if sending, (try? JSONDecoder().decode(ErrorBody.self, from: data).code) == "limit_reached" {
                throw GuestSendRejection.limitReached
            }
            let delay = Double(response.value(forHTTPHeaderField: "Retry-After") ?? "") ?? 1
            throw GuestError.retryAfter(min(3600, max(1, delay)))
        default: throw GuestError.unavailable
        }
        if T.self == EmptyReply.self, data.isEmpty { return try JSONDecoder().decode(T.self, from: Data("{}".utf8)) }
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw GuestError.invalidResponse }
    }
}

public enum GuestSendRejection: Error, Sendable { case invalidMessage, limitReached }

private final class NoRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}