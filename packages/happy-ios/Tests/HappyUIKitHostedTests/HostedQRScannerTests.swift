#if canImport(UIKit)
import AVFoundation
import HappyCore
import HappyStore
@testable import HappyUI
import HappyWire
import UIKit
import XCTest

/// A QR code as the camera's metadata output hands it over. AVFoundation
/// makes these only from a live camera, which the simulator lacks, so this
/// one comes from the runtime with its text overridden.
private final class ScannedQR: AVMetadataMachineReadableCodeObject {
    nonisolated(unsafe) static var text: String?
    override var stringValue: String? { Self.text }
    override var type: AVMetadataObject.ObjectType { .qr }

    static func make(_ text: String) -> AVMetadataObject {
        Self.text = text
        // swiftlint:disable:next force_cast
        return (ScannedQR.self as NSObject.Type).init() as! AVMetadataObject
    }
}

/// The relay server's two auth calls a terminal approval makes; every other
/// call fails, as with no network.
private final class PairingServer: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _requests: [HTTPRequest] = []
    var requests: [HTTPRequest] { lock.withLock { _requests } }

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        lock.withLock { _requests.append(request) }
        switch (request.method, request.url.path) {
        case ("GET", "/v1/auth/request/status"):
            return HTTPResponse(status: 200, body: Data(#"{"status":"pending","supportsV2":true}"#.utf8))
        case ("POST", "/v1/auth/response"):
            return HTTPResponse(status: 200, body: Data(#"{"success":true}"#.utf8))
        default:
            throw URLError(.notConnectedToInternet)
        }
    }
}

private struct NoSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection {
        throw URLError(.notConnectedToInternet)
    }
}

/// A code read by the camera, from the metadata delegate on: the scanner
/// closes, the code is routed, the computer is approved on the server and
/// the person is told. This is the path Steve's scans take after the
/// camera; only the camera itself is stood in for.
@MainActor
final class HostedQRScannerTests: XCTestCase {
    /// happy-cli's code for a fresh key (HappyCodeProducerTests).
    private let cliCode = "happy://terminal?kBukXBnw_3YJE7lEpK-ikL1EuSGfcgvR-W6WpOsDKTc"
    private var window: UIWindow?

    override func tearDown() async throws {
        window?.isHidden = true
        window = nil
        try await super.tearDown()
    }

    private func wait(_ seconds: Double = 5, _ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = ContinuousClock.now + .seconds(seconds)
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(condition(), "never reached the expected state", file: file, line: line)
    }

    private func signedIn(_ server: PairingServer) async throws -> AppContext {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()),
            clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(),
            storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: server,
            connector: NoSockets()
        )
        try await controller.signIn(Credentials(token: "t", secret: Data(repeating: 1, count: 32)))
        return AppContext(account: controller, variant: .development, version: "test")
    }

    /// The screen a scan starts from, and the scanner once it is up.
    private func openScanner(_ start: (UIViewController) -> Void) async throws -> (UINavigationController, QRScannerViewController) {
        let navigation = UINavigationController(rootViewController: UIViewController())
        window = hostedKeyWindow(in: try await hostedActiveScene(), root: navigation)
        let host = try XCTUnwrap(navigation.topViewController)
        start(host)
        try await wait { (navigation.presentedViewController as? QRScannerViewController).map { !$0.isBeingPresented } ?? false }
        return (navigation, try XCTUnwrap(navigation.presentedViewController as? QRScannerViewController))
    }

    private func deliver(_ objects: [AVMetadataObject], to scanner: QRScannerViewController) {
        let output = AVCaptureMetadataOutput()
        scanner.capture.metadataOutput(output, didOutput: objects, from: AVCaptureConnection(inputPorts: [], output: output))
    }

    func testACLICodeTheCameraReadsConnectsTheComputer() async throws {
        let server = PairingServer()
        let context = try await signedIn(server)
        var result: HappyScan.Result?
        let (navigation, scanner) = try await openScanner { host in
            Task { result = await HappyScan.scan(intent: .connect, context: context, on: host) }
        }
        deliver([ScannedQR.make(cliCode)], to: scanner)

        try await wait { result != nil }
        XCTAssertEqual(result, .computerConnected)
        XCTAssertNil(scanner.presentingViewController, "the scanner closes once it has read a code")
        let approval = try XCTUnwrap(server.requests.first { $0.method == "POST" && $0.url.path == "/v1/auth/response" }, "the computer was never approved")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(approval.body)) as? [String: Any])
        let key = try XCTUnwrap(HappyCode(cliCode).terminalKey)
        XCTAssertEqual(body["publicKey"] as? String, key.base64EncodedString())
        try await wait { navigation.presentedViewController is UIAlertController }
        let alert = try XCTUnwrap(navigation.presentedViewController as? UIAlertController)
        XCTAssertEqual(alert.title, Strings.Common.success)
        XCTAssertEqual(alert.message, Strings.Modals.terminalConnectedSuccessfully)
        await context.account.signOut()
    }

    /// The output reports the same code frame after frame until the
    /// scanner is gone: only the first counts.
    func testACodeReadOverAndOverFinishesOnce() async throws {
        var reads: [String?] = []
        let (navigation, scanner) = try await openScanner { host in
            Task { reads.append(await HappyScan.read(from: host)) }
        }
        deliver([ScannedQR.make(cliCode), ScannedQR.make(cliCode)], to: scanner)
        deliver([ScannedQR.make("happy:///account?other")], to: scanner)
        try await wait { !reads.isEmpty && navigation.presentedViewController == nil }
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(reads, [cliCode])
    }

    /// A batch with nothing readable in it (a code whose bytes aren't text)
    /// leaves the scanner open.
    func testNothingReadableKeepsScanning() async throws {
        let (navigation, scanner) = try await openScanner { host in
            Task { _ = await HappyScan.read(from: host) }
        }
        ScannedQR.text = nil
        deliver([(ScannedQR.self as NSObject.Type).init() as! AVMetadataObject], to: scanner)
        deliver([], to: scanner)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertTrue(navigation.presentedViewController === scanner)
        scanner.capture.onCode?("done")
        try await wait { navigation.presentedViewController == nil }
    }

    /// The simulator has no camera: the scanner says so at once, without
    /// asking for one.
    func testWithoutACameraTheScannerSaysSo() async throws {
        let (_, scanner) = try await openScanner { host in
            Task { _ = await HappyScan.read(from: host) }
        }
        XCTAssertNil(scanner.capture.device)
        scanner.view.layoutIfNeeded()
        let texts = scanner.view.subviews.compactMap { ($0 as? StyledLabel).flatMap { $0.isHidden ? nil : $0.string } }
        XCTAssertEqual(texts, [Strings.Scanner.unavailable])
        scanner.capture.onCode?("done")
    }

    /// A scan started over a sheet still opens, over the sheet: UIKit would
    /// drop it from the screen under, and the scan would never end.
    func testAScanFromUnderASheetStillOpens() async throws {
        let navigation = UINavigationController(rootViewController: UIViewController())
        window = hostedKeyWindow(in: try await hostedActiveScene(), root: navigation)
        let sheet = UIViewController()
        navigation.present(sheet, animated: false)
        let host = try XCTUnwrap(navigation.topViewController)
        var read: String??
        Task { read = await HappyScan.read(from: host) }
        try await wait { sheet.presentedViewController is QRScannerViewController }
        let scanner = try XCTUnwrap(sheet.presentedViewController as? QRScannerViewController)
        try await wait { !scanner.isBeingPresented }
        deliver([ScannedQR.make(cliCode)], to: scanner)
        try await wait { read != nil }
        XCTAssertEqual(read, .some(cliCode))
    }
}

private extension HappyCode {
    var terminalKey: Data? {
        if case .terminal(let key) = self { return key }
        return nil
    }
}
#endif
