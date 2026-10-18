import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// Opt-in: the private fixture path is supplied only by the Mac interop job.
/// This uses the production Tailcat socket adapter against the real daemon.
final class DirectDaemonInteropTests: XCTestCase {
    func testRealDaemonOverTailcat() async throws {
        guard let directory = ProcessInfo.processInfo.environment["HAPPY_DIRECT_E2E_DIR"] else { throw XCTSkip("Requires isolated mobile-connector daemon") }
        let root = URL(fileURLWithPath: directory)
        let text = try String(contentsOf: root.appendingPathComponent("qr.txt"), encoding: .utf8)
        let link = try DirectPairingLink(text)
        let service = DirectPairingService(link: link)
        let emoji = try await service.start(deviceName: "Native Swift interop test")
        for _ in 0..<100 where !FileManager.default.fileExists(atPath: root.appendingPathComponent("desktop-emoji.json").path) { try await Task.sleep(for: .milliseconds(100)) }
        let desktopEmoji = try JSONDecoder().decode([String].self, from: Data(contentsOf: root.appendingPathComponent("desktop-emoji.json")))
        XCTAssertEqual(emoji, desktopEmoji)
        let credentials = try await service.confirm()
        let transport = TailcatHTTPTransport(address: credentials.address, port: credentials.port)
        do {
            let account = try await DirectIdentity.refresh(DirectAccount(id: "interop", name: "Unverified"), transport: transport, token: credentials.deviceToken)
            XCTAssertEqual(account.name, "Tailcat Test Mac")
            XCTAssertEqual(account.status, .connected)
            let forbidden = try await transport.request("/v0/mobile-connector", credential: credentials.deviceToken)
            XCTAssertEqual(forbidden.status, 403)
            await transport.close()
        } catch { await transport.close(); throw error }
    }
}