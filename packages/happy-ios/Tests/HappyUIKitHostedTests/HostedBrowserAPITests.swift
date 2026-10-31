#if canImport(UIKit)
import Foundation
@testable import HappyCore
@testable import HappyUI
import Network
import UIKit
import WebKit
import XCTest

/// Opt-in black-box test. Start scripts/browser-api-gym.ts first. No API
/// answers are mocked: only the encrypted remote link is replaced by loopback.
@MainActor
final class HostedBrowserAPITests: XCTestCase {
    private struct Fixture: Decodable { let port: UInt16; let token: String; let artifactID: String }

    func testRealDaemonArtifactAPIUnderBulkLoad() async throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let fixtureURL = root.appendingPathComponent(".context/browser-api-gym.json")
        guard FileManager.default.fileExists(atPath: fixtureURL.path) else {
            throw XCTSkip("Start scripts/browser-api-gym.ts to run the real daemon browser test")
        }
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: fixtureURL))
        let transport = FixtureTransport(port: fixture.port)
        let client = AgentClient(transport: transport, token: fixture.token)
        let page = try await BrowserPage.artifact(client: client, id: fixture.artifactID, version: 1, entry: "index.html")
        let browser = BrowserViewController(url: page.url, artifactID: fixture.artifactID, page: page)
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: UINavigationController(rootViewController: browser))
        defer { window.isHidden = true }
        for _ in 0..<1800 {
            if let web = browser.view.subviews.compactMap({ $0 as? WKWebView }).first,
               let result = try? await web.evaluateJavaScript("window.browserAPIResults"),
               let object = result as? [String: Any], object["done"] as? Bool == true {
                let text = String(describing: object)
                let attachment = XCTAttachment(string: text); attachment.name = "Real daemon API results"; attachment.lifetime = .keepAlways; add(attachment)
                print("REAL_DAEMON_BROWSER_API: \(text)")
                XCTAssertEqual((object["failures"] as? [Any])?.count, 0, text)
                XCTAssertEqual((object["cases"] as? [String])?.count, 13, text)
                XCTAssertEqual(object["seeded"] as? Int, 1005, text)
                let connections = await transport.connections
                print("REAL_DAEMON_BROWSER_CONNECTIONS: \(connections)")
                XCTAssertLessThan(connections, 30, "Bulk API requests should reuse upstream connections")
                return
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTFail("Real daemon browser test did not finish within 180 seconds")
    }
}

private actor FixtureTransport: AgentTransport {
    let port: UInt16
    private(set) var connections = 0
    init(port: UInt16) { self.port = port }
    func browserConnection() async throws -> any BrowserStream {
        connections += 1
        let connection = NWConnection(host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
        connection.start(queue: DispatchQueue(label: "browser-api-fixture"))
        return NetworkBrowserStream(connection)
    }
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)\(path)")!)
        request.httpMethod = method; request.httpBody = body
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        request.setValue("Bearer \(credential)", forHTTPHeaderField: "Authorization")
        let (bytes, response) = try await URLSession.shared.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw BrowserError.malformed }
        return HTTP1Response(status: response.statusCode, body: bytes)
    }
    func close() async {}
}
#endif