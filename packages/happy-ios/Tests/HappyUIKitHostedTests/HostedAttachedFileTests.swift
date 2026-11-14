#if canImport(UIKit)
import Foundation
@testable import HappyCore
import HappyLayout
import HappyWire
@testable import HappyUI
import QuickLook
import UIKit
import XCTest

private struct FileOffline: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct FileNoSocket: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// One agent, `a`, whose history has a message someone sent from another
/// device with two files attached: a PDF the computer holds, and a
/// document it no longer has (404). Attachments are served a range at a time.
private actor AttachedFileComputer: AgentTransport {
    let files: [String: ArtifactDaemon.File]
    let run: JSONValue
    private(set) var fetched: [String] = []

    init(files: [String: ArtifactDaemon.File], run: JSONValue) {
        self.files = files
        self.run = run
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) throws -> HTTP1Response {
        if let range = path.range(of: "/attachments/") {
            let id = String(path[range.upperBound...])
            fetched.append(id)
            guard let file = files[id] else { return HTTP1Response(status: 404, body: Data(#"{"error":"Not found","code":"not_found"}"#.utf8)) }
            return ArtifactDaemon.serve(file, range: headers["Range"])
        }
        let value: JSONValue
        if path.contains("/agents/a/messages?") {
            value = .object(["hasMore": .bool(false), "runs": .array([run])])
        } else if path.hasSuffix("/agents/a/bootstrap") {
            value = .object(["agent": .object(["id": .string("a"), "workspaceId": .string("w"), "status": .string("idle")]), "pending": .array([])])
        } else {
            value = .object([:])
        }
        return .init(status: 200, body: try JSONEncoder().encode(value))
    }

    func close() {}
}

/// A file someone attached to their message that is no picture or video is
/// a card under their words, as an agent's file is: its chip follows the
/// download, a tap reads it and opens it in Quick Look, and one the computer
/// no longer has says it can't be opened.
@MainActor
final class HostedAttachedFileTests: XCTestCase {
    private static let pdfID = String(repeating: "a", count: 64)
    private static let goneID = String(repeating: "b", count: 64)

    private static func pdf() -> Data {
        UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 200, height: 200)).pdfData { context in
            context.beginPage()
            ("Quarterly report" as NSString).draw(at: CGPoint(x: 20, y: 20), withAttributes: [.font: UIFont.systemFont(ofSize: 18)])
        }
    }

    private static func file(_ id: String, _ name: String, mimeType: String, size: Int) -> JSONValue {
        .object(["type": .string("file"), "attachment": .string(id), "name": .string(name), "mimeType": .string(mimeType), "size": .number(Double(size)), "kind": .string("document")])
    }

    private func computer() -> AttachedFileComputer {
        let pdf = Self.pdf()
        let run: JSONValue = .object(["id": .string("r"), "status": .string("completed"), "startedAt": .number(1_000), "endedAt": .number(2_000), "reason": .string("completed"),
            "messages": .array([.object([
                "id": .string("u"), "role": .string("user"), "createdAt": .number(1_000), "metadata": .object([:]),
                "content": .array([
                    .object(["type": .string("text"), "text": .string("Here are the numbers")]),
                    Self.file(Self.pdfID, "report.pdf", mimeType: "application/pdf", size: pdf.count),
                    Self.file(Self.goneID, "old.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 1200),
                ]),
            ])]),
        ])
        return AttachedFileComputer(files: [Self.pdfID: ArtifactDaemon.File(path: "report.pdf", mimeType: "application/pdf", data: pdf)], run: run)
    }

    private func open(_ computer: AttachedFileComputer) async throws -> (ChatViewController, UIWindow) {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in computer },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: FileOffline(), connector: FileNoSocket()
        )
        await controller.agentConnections.setForeground(false)
        let pairing = try await controller.agentConnections.add(
            JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"file-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
            name: "Mac"
        )
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let session = try XCTUnwrap(Session.session(for: pairing.id, context: context))
        let chat = ChatViewController(session: session, agentId: "a", title: "Files", spaceId: nil, intro: nil)
        let scene = try await hostedActiveScene()
        let window = hostedKeyWindow(in: scene, root: UINavigationController(rootViewController: chat))
        window.layoutIfNeeded()
        addTeardownBlock { @MainActor in
            if let presented = window.rootViewController?.presentedViewController {
                await withCheckedContinuation { continuation in presented.dismiss(animated: false) { continuation.resume() } }
            }
            window.isHidden = true
            Session.forget(pairing.id)
            try? await controller.agentConnections.remove(pairing.id)
        }
        return (chat, window)
    }

    private func until(_ what: String, _ seconds: Double = 8, _ condition: () async -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("never: \(what)", file: file, line: line)
    }

    private func plan(_ chat: ChatViewController) -> ChatRowPlan? { chat.plans.first { $0.id == "u" } }

    func testAReceivedPDFIsACardThatOpensInQuickLook() async throws {
        let computer = computer()
        let (chat, window) = try await open(computer)
        try await until("the message") { plan(chat) != nil }
        let row = try XCTUnwrap(plan(chat))
        // Each file a card with its download status, under the words.
        let statuses = row.items.compactMap { if case .fileStatus(let status, let frame) = $0 { (status, frame) } else { nil } }
        XCTAssertEqual(statuses.map(\.0.key), ["attachment/\(Self.pdfID)", "attachment/\(Self.goneID)"])
        XCTAssertEqual(row.accessibilityLabel, "Here are the numbers, report.pdf, old.docx")
        let texts = row.items.compactMap { if case .text(let layout, _) = $0 { layout.string.string } else { nil } }
        XCTAssertFalse(texts.contains { $0.contains("📎") }, "no file is only named")
        XCTAssertNotNil(row.hits.first { $0.action == .toggleDownload("attachment/\(Self.pdfID)") }, "its chip reads it")
        let open = try XCTUnwrap(row.hits.first { $0.action == .openMedia("attachment/\(Self.pdfID)") }, "the card opens it")
        XCTAssertTrue(open.frame.contains(CGPoint(x: statuses[0].1.midX, y: statuses[0].1.midY)))

        chat.act(open.action)
        try await until("Quick Look", 10) { window.rootViewController?.presentedViewController is QLPreviewController }
        let fetched = await computer.fetched
        XCTAssertTrue(fetched.contains(Self.pdfID), "read from the attachments route: \(fetched)")
    }

    func testAFileTheComputerNoLongerHasSaysSo() async throws {
        let (chat, window) = try await open(computer())
        try await until("the message") { plan(chat) != nil }
        let gone = try XCTUnwrap(plan(chat)?.hits.first { $0.action == .openMedia("attachment/\(Self.goneID)") })
        chat.act(gone.action)
        try await until("the alert", 10) { window.rootViewController?.presentedViewController is UIAlertController }
        let alert = try XCTUnwrap(window.rootViewController?.presentedViewController as? UIAlertController)
        XCTAssertEqual(alert.message, Strings.fileUnavailable)
    }
}
#endif
