import Foundation
import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
#if canImport(HappyGuest)
@testable import HappyGuest
#endif

@MainActor final class GuestClientTests: XCTestCase {
    func testRedeemSendsOnlyInvitationThenWritesUseScopedBearerAndStableID() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [GuestHTTPStub.self]
        let client = GuestClient(origin: URL(string: "https://app.happy.engineering")!, transport: URLSession(configuration: configuration))
        let invitation = try XCTUnwrap(GuestInvitation(url: URL(string: "https://app.happy.engineering/bot/invite/abcdefghijklmnop")!))
        GuestHTTPStub.state.configure(status: 200, body: #"{"sessionId":"guest-session","sessionToken":"scoped-test-token","botName":"Helper","expiresAt":9999999999999,"readOnly":false}"#)
        let session = try await client.redeem(invitation, redeemNonce: "test-nonce")
        var requests = GuestHTTPStub.state.requests()
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests[0].url?.path, "/v1/bot-invites/redeem")
        XCTAssertNil(requests[0].value(forHTTPHeaderField: "Authorization"))
        let body = try XCTUnwrap(try JSONSerialization.jsonObject(with: XCTUnwrap(requests[0].httpBody)) as? [String: String])
        XCTAssertEqual(body, ["token": "abcdefghijklmnop", "redeemNonce": "test-nonce"])

        GuestHTTPStub.state.configure(status: 204, body: "")
        try await client.send(session: session, localId: "stable-id", text: "Hello")
        try await client.send(session: session, localId: "stable-id", text: "Hello")
        requests = GuestHTTPStub.state.requests()
        XCTAssertEqual(requests.count, 2)
        for request in requests {
            XCTAssertEqual(request.url?.path, "/v1/bot-guest/sessions/guest-session/messages")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer scoped-test-token")
            let body = try XCTUnwrap(try JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: String])
            XCTAssertEqual(body, ["localId": "stable-id", "text": "Hello"])
        }
    }

    func testExpiredAndRevokedCapabilitiesAreTerminalErrors() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [GuestHTTPStub.self]
        let client = GuestClient(origin: URL(string: "https://app.happy.engineering")!, transport: URLSession(configuration: configuration))
        let invitation = try XCTUnwrap(GuestInvitation(url: URL(string: "https://app.happy.engineering/bot/invite/abcdefghijklmnop")!))
        for (status, expected) in [(410, GuestError.expired), (401, .revoked), (403, .readOnly)] {
            GuestHTTPStub.state.configure(status: status, body: "{}")
            do {
                _ = try await client.redeem(invitation, redeemNonce: "test-nonce")
                XCTFail("Capability error \(status) must not grant a session")
            } catch { XCTAssertEqual(error as? GuestError, expected) }
        }
    }

    func testSecureSessionSurvivesRestartAndRemovalWipesIt() async throws {
        let storage = GuestMemoryStorage()
        let vault = GuestSessionVault(storage: storage)
        let session = try JSONDecoder().decode(GuestSession.self, from: Data(#"{"sessionId":"guest-session","sessionToken":"scoped-test-token","botName":"Helper","expiresAt":9999999999999,"readOnly":false}"#.utf8))
        let saved = StoredGuestSession(origin: URL(string: "https://app.happy.engineering")!, invitationID: "invite-hash", session: session,
                                       pending: GuestPendingMessage(localId: "stable-id", text: "Hello"))
        try await vault.save(saved)
        let restarted = GuestSessionVault(storage: storage)
        let restoredValue = try await restarted.restore()
        let restored = try XCTUnwrap(restoredValue)
        XCTAssertEqual(restored.session.sessionToken, "scoped-test-token")
        XCTAssertEqual(restored.pending?.localId, "stable-id")
        try await restarted.remove(invitationID: "invite-hash")
        let cleared = try await vault.restore(invitationID: "invite-hash")
        XCTAssertNil(cleared)
        XCTAssertNil(try storage.read())
    }

    func testLostRedeemResponseKeepsNonceAndRecoversSameInvitationAfterRestart() async throws {
        let storage = GuestMemoryStorage()
        let factory: @Sendable (URL) -> GuestClient = { origin in
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [GuestHTTPStub.self]
            return GuestClient(origin: origin, transport: URLSession(configuration: configuration))
        }
        let vault = GuestSessionVault(storage: storage, makeClient: factory)
        let invitation = try XCTUnwrap(GuestInvitation(url: URL(string: "https://app.happy.engineering/bot/invite/abcdefghijklmnop")!))
        GuestHTTPStub.state.configure(status: 503, body: "{}")
        do { _ = try await vault.redeem(invitation, origin: invitation.origin); XCTFail("Expected retryable response loss") }
        catch { XCTAssertEqual(error as? GuestError, .retryAfter(1)) }
        let pendingValue = try await vault.pendingRedemption()
        let pending = try XCTUnwrap(pendingValue)
        XCTAssertEqual(pending.redeemNonce.count, 43)

        GuestHTTPStub.state.configure(status: 200, body: #"{"sessionId":"guest-session","sessionToken":"recovered-token","botName":"Helper","expiresAt":9999999999999,"readOnly":false}"#)
        let restarted = GuestSessionVault(storage: storage, makeClient: factory)
        let stored = try await restarted.redeem(invitation, origin: invitation.origin)
        XCTAssertEqual(stored.session.sessionToken, "recovered-token")
        let request = try XCTUnwrap(GuestHTTPStub.state.requests().first)
        let body = try XCTUnwrap(try JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: String])
        XCTAssertEqual(body["redeemNonce"], pending.redeemNonce)
        let cleared = try await restarted.pendingRedemption()
        XCTAssertNil(cleared)
        let resumed = try await restarted.restore()
        XCTAssertEqual(resumed?.session.sessionToken, "recovered-token")
    }

    func testConcurrentRedeemsShareOneHTTPRequest() async throws {
        let storage = GuestMemoryStorage()
        let vault = makeVault(storage)
        let invitation = try XCTUnwrap(GuestInvitation(url: URL(string: "https://app.happy.engineering/bot/invite/abcdefghijklmnop")!))
        let gate = DispatchSemaphore(value: 0)
        defer { gate.signal() }
        GuestHTTPStub.state.configure(status: 200, body: sessionReply, gate: gate)
        let first = Task { try await vault.redeem(invitation, origin: invitation.origin) }
        let second = Task { try await vault.redeem(invitation, origin: invitation.origin) }
        try await waitForRequest()
        gate.signal()
        let one = try await first.value
        let two = try await second.value
        XCTAssertEqual(one.session.sessionToken, two.session.sessionToken)
        XCTAssertEqual(GuestHTTPStub.state.requests().count, 1)
    }

    func testRemoveDuringRedeemCannotResurrectStoredCredentials() async throws {
        let storage = GuestMemoryStorage()
        let vault = makeVault(storage)
        let invitation = try XCTUnwrap(GuestInvitation(url: URL(string: "https://app.happy.engineering/bot/invite/abcdefghijklmnop")!))
        let gate = DispatchSemaphore(value: 0)
        defer { gate.signal() }
        GuestHTTPStub.state.configure(status: 200, body: sessionReply, gate: gate)
        let request = Task { try await vault.redeem(invitation, origin: invitation.origin) }
        try await waitForRequest()
        try await vault.remove(invitationID: invitation.identifier)
        gate.signal()
        do { _ = try await request.value; XCTFail("Removed credentials must not be restored") }
        catch { XCTAssertEqual(error as? GuestError, .revoked) }
        let restored = try await vault.restore(invitationID: invitation.identifier)
        XCTAssertNil(restored)
        XCTAssertNil(try storage.read())
    }

    func testOldExpiredSessionsArePrunedAfterOneDayGrace() async throws {
        let storage = GuestMemoryStorage()
        let vault = GuestSessionVault(storage: storage)
        let session = try JSONDecoder().decode(GuestSession.self, from: Data(#"{"sessionId":"old-session","sessionToken":"old-token","botName":"Helper","expiresAt":1,"readOnly":false}"#.utf8))
        try await vault.save(StoredGuestSession(origin: URL(string: "https://app.happy.engineering")!, invitationID: "old", session: session))
        let restored = try await vault.restore()
        XCTAssertNil(restored)
        XCTAssertNil(try storage.read())
    }

    private var sessionReply: String {
        #"{"sessionId":"guest-session","sessionToken":"scoped-test-token","botName":"Helper","expiresAt":9999999999999,"readOnly":false}"#
    }

    private func makeVault(_ storage: GuestMemoryStorage) -> GuestSessionVault {
        GuestSessionVault(storage: storage) { origin in
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [GuestHTTPStub.self]
            return GuestClient(origin: origin, transport: URLSession(configuration: configuration))
        }
    }

    private func waitForRequest() async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while GuestHTTPStub.state.requests().isEmpty, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertEqual(GuestHTTPStub.state.requests().count, 1)
    }
}

private final class GuestMemoryStorage: GuestSecretStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data?
    func read() throws -> Data? { lock.lock(); defer { lock.unlock() }; return data }
    func write(_ data: Data) throws { lock.lock(); defer { lock.unlock() }; self.data = data }
    func delete() throws { lock.lock(); defer { lock.unlock() }; data = nil }
}

private final class GuestHTTPStub: URLProtocol, @unchecked Sendable {
    static let state = State()

    final class State: @unchecked Sendable {
        private let lock = NSLock()
        private var status = 200
        private var body = Data()
        private var captured: [URLRequest] = []
        private var gate: DispatchSemaphore?

        func configure(status: Int, body: String, gate: DispatchSemaphore? = nil) {
            lock.lock(); defer { lock.unlock() }
            self.status = status
            self.body = Data(body.utf8)
            captured = []
            self.gate = gate
        }

        func requests() -> [URLRequest] {
            lock.lock(); defer { lock.unlock() }
            return captured
        }

        func response(for request: URLRequest) -> (Int, Data, DispatchSemaphore?) {
            lock.lock(); defer { lock.unlock() }
            captured.append(request)
            return (status, body, gate)
        }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var captured = request
        // URLSession presents POST bodies to URLProtocol as streams on iOS.
        if captured.httpBody == nil, let stream = captured.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 1_024)
            while true {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(contentsOf: buffer.prefix(count))
            }
            captured.httpBody = data
        }
        let (status, body, gate) = Self.state.response(for: captured)
        gate?.wait()
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}