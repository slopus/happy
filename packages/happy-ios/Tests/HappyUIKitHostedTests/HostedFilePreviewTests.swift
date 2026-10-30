#if canImport(UIKit)
import HappyCore
@testable import HappyUI
import UIKit
import XCTest

private struct PreviewNoComputer: AgentTransport {
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        throw URLError(.notConnectedToInternet)
    }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        throw URLError(.notConnectedToInternet)
    }
    func reset() async {}
    func close() async {}
}

/// Forgetting one computer touches nothing of another's. Preview files are
/// not filed by computer, so forgetting used to clear all of them, and with
/// them the file under a preview another computer still had on screen.
@MainActor
final class HostedFilePreviewTests: XCTestCase {
    func testForgettingAComputerLeavesAnotherComputersOpenPreview() async throws {
        let account = AccountController(serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "preview-test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil, agentTransport: { _ in PreviewNoComputer() })
        await account.agentConnections.setForeground(false)
        func pair(_ name: String) async throws -> AgentConnection {
            try await account.agentConnections.add(JSONDecoder().decode(AgentConnectionCredentials.self,
                from: Data(#"{"address":"preview-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"test"}"#.utf8)), name: name)
        }
        let gone = try await pair("Going")
        let kept = try await pair("Previewing")
        let context = AppContext(account: account, variant: .preview, version: "test")
        _ = try XCTUnwrap(Session.session(for: gone.id, context: context))
        // Where an open preview of the other computer's document is read to.
        let folder = FilePreview.root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let file = folder.appendingPathComponent("report.pdf")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try Data("still being read".utf8).write(to: file)
        defer { try? FileManager.default.removeItem(at: folder) }

        Session.forget(gone.id)
        // The old purge ran on a detached task; give anything like it time.
        try await Task.sleep(for: .milliseconds(500))

        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path), "another computer's open preview keeps its file")
        XCTAssertEqual(try? Data(contentsOf: file), Data("still being read".utf8))
        try await account.agentConnections.remove(gone.id)
        try await account.agentConnections.remove(kept.id)
    }
}
#endif
