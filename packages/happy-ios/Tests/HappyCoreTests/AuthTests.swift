import Foundation
import XCTest
@testable import HappyCore
import HappyCrypto
import HappyWire

final class AuthServiceTests: XCTestCase {
    func testSignInSignsAChallengeTheServerCanVerify() async throws {
        let http = FakeHTTP()
        http.on("POST /v1/auth") { request in
            let body = try request.jsonBody(AuthRequest.self)
            let valid = SigningKeyPair.verify(
                signature: Base64.decode(body.signature)!,
                message: Base64.decode(body.challenge)!,
                publicKey: Base64.decode(body.publicKey)!
            )
            return valid ? (200, Data(#"{"success":true,"token":"tok"}"#.utf8)) : (401, Data())
        }
        let secret = SystemRandom().bytes(32)
        let credentials = try await AuthService(api: testAPI(http, token: nil)).signIn(secret: secret)
        XCTAssertEqual(credentials.token, "tok")
        XCTAssertEqual(credentials.secretData, secret)

        let body = try http.requests[0].jsonBody(AuthRequest.self)
        XCTAssertEqual(Base64.decode(body.publicKey), try AccountKeys(secret: secret).signingKeyPair.publicKey)
        XCTAssertNil(http.requests[0].headers["Authorization"])
    }

    func testRestoreAcceptsTheBackupFormat() async throws {
        let http = FakeHTTP()
        http.onRaw("POST /v1/auth", #"{"success":true,"token":"tok"}"#)
        let secret = SystemRandom().bytes(32)
        let credentials = try await AuthService(api: testAPI(http, token: nil)).restore(secretKey: SecretKeyBackup.format(secret: secret))
        XCTAssertEqual(credentials.secretData, secret)
        await XCTAssertThrowsAsync(try await AuthService(api: testAPI(http, token: nil)).restore(secretKey: "nope"))
    }

    func testCredentialsJSONMatchesTheRNTokenStorage() throws {
        let credentials = Credentials(token: "t", secret: Data(repeating: 0xfb, count: 32))
        let json = try JSONValue.decode(JSONEncoder().encode(credentials))
        XCTAssertEqual(json["token"], .string("t"))
        XCTAssertEqual(json["secret"], .string("-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_s"))
        XCTAssertNil(Credentials(token: "t", secret: "short").secretData)
    }

    func testQRLoginReceivesTheSecretFromTheApprovingDevice() async throws {
        let http = FakeHTTP()
        let existingAccount = try AccountKeys(secret: SystemRandom().bytes(32))
        let approvals = ApprovalBox()
        http.on("POST /v1/auth/account/request") { request in
            let key = Base64.decode(try request.jsonBody(AccountAuthRequest.self).publicKey)!
            guard let response = approvals.response else {
                approvals.requestedKey = key
                return (200, Data(#"{"state":"requested"}"#.utf8))
            }
            return (200, Data(#"{"state":"authorized","token":"new-token","response":"\#(response)"}"#.utf8))
        }

        let login = try AuthService(api: testAPI(http, token: nil)).startQRLogin()
        try await login.register()
        let pending = try await login.poll()
        XCTAssertNil(pending)

        // The other phone scans the QR and answers.
        guard case .account(let scannedKey)? = PairingLink(login.link.urlString) else { return XCTFail() }
        XCTAssertEqual(scannedKey, approvals.requestedKey)
        approvals.response = Base64.encode(try existingAccount.accountLinkApproval(devicePublicKey: scannedKey))

        let credentials = try await login.waitForApproval(pollInterval: .milliseconds(1))
        XCTAssertEqual(credentials.token, "new-token")
        XCTAssertEqual(credentials.secretData, existingAccount.secret)
    }

    func testQRLoginRejectsAnAnswerSealedToSomeoneElse() async throws {
        let http = FakeHTTP()
        let stranger = try BoxKeyPair.generate()
        let bogus = Base64.encode(try Box.sealAnonymous(SystemRandom().bytes(32), recipientPublicKey: stranger.publicKey))
        http.onRaw("POST /v1/auth/account/request", #"{"state":"authorized","token":"t","response":"\#(bogus)"}"#)
        let login = try AuthService(api: testAPI(http, token: nil)).startQRLogin()
        await XCTAssertThrowsAsync(try await login.poll()) {
            XCTAssertEqual($0 as? QRLoginError, .undecryptableResponse)
        }
    }
}

final class PairingServiceTests: XCTestCase {
    let keys = try! AccountKeys(secret: SystemRandom().bytes(32))

    func testConnectsAV2TerminalWithTheContentPublicKey() async throws {
        let http = FakeHTTP()
        let terminal = try BoxKeyPair.generate()
        http.onRaw("GET /v1/auth/request/status", #"{"status":"pending","supportsV2":true}"#)
        http.onRaw("POST /v1/auth/response", #"{"success":true}"#)

        let outcome = try await PairingService(api: testAPI(http), keys: keys).approve(.terminal(publicKey: terminal.publicKey))
        XCTAssertEqual(outcome, .terminalConnected)

        XCTAssertEqual(http.requests[0].query("publicKey"), terminal.publicKey.base64EncodedString())
        let approval = try http.requests[1].jsonBody(AuthApproval.self)
        XCTAssertEqual(approval.publicKey, terminal.publicKey.base64EncodedString())
        let opened = try XCTUnwrap(Box.openAnonymous(Base64.decode(approval.response)!, recipientSecretKey: terminal.secretKey))
        XCTAssertEqual(opened, Data([0]) + keys.contentKeyPair.publicKey)
        XCTAssertEqual(http.requests[1].headers["Authorization"], "Bearer token-1")
    }

    func testRefusesV1TerminalsInsteadOfSendingTheSecret() async throws {
        let http = FakeHTTP()
        http.onRaw("GET /v1/auth/request/status", #"{"status":"pending","supportsV2":false}"#)
        await XCTAssertThrowsAsync(try await PairingService(api: testAPI(http), keys: self.keys).approve(.terminal(publicKey: Data(count: 32)))) {
            XCTAssertEqual($0 as? PairingError, .terminalNeedsUpdate)
        }
        XCTAssertTrue(http.requests("POST /v1/auth/response").isEmpty)
    }

    func testAlreadyHandledRequestsSendNothing() async throws {
        let http = FakeHTTP()
        http.onRaw("GET /v1/auth/request/status", #"{"status":"not_found","supportsV2":false}"#)
        let outcome = try await PairingService(api: testAPI(http), keys: keys).approve(.terminal(publicKey: Data(count: 32)))
        XCTAssertEqual(outcome, .alreadyHandled)
        XCTAssertEqual(http.requests.count, 1)
    }

    func testLinksAnotherDevice() async throws {
        let http = FakeHTTP()
        let device = try BoxKeyPair(seed: SystemRandom().bytes(32))
        http.onRaw("POST /v1/auth/account/response", #"{"success":true}"#)
        let outcome = try await PairingService(api: testAPI(http), keys: keys).approve(.account(publicKey: device.publicKey))
        XCTAssertEqual(outcome, .deviceLinked)
        let approval = try http.requests[0].jsonBody(AuthApproval.self)
        XCTAssertEqual(Box.openAnonymous(Base64.decode(approval.response)!, recipientSecretKey: device.secretKey), keys.secret)
    }
}

private final class ApprovalBox: @unchecked Sendable {
    var requestedKey: Data?
    var response: String?
}
