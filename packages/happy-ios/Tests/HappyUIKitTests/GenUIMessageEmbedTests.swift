#if canImport(UIKit)
@testable import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

@MainActor
final class GenUIMessageEmbedTests: XCTestCase {
    func testActionsCarryTheOriginAndCannotAcquireArtifactAuthority() async throws {
        let folder = Bundle(for: Self.self).resourceURL!.appendingPathComponent("GenUI")
        let document = try XCTUnwrap(GenUIRenderDocument.parse(Data(contentsOf: folder.appendingPathComponent("01-stats.render.json"))))
        let host = MessageHost()
        host.loadViewIfNeeded()
        host.view.backgroundColor = .systemBackground
        let block = GenUIBlockView()
        host.view.addSubview(block)
        let embed = GenUIMessageEmbed(agentId: "origin", toolCallId: "call", document: document, width: 361, environment: nil)
        block.frame = CGRect(x: 16, y: 80, width: 361, height: embed.height)
        block.apply(embed)
        let deadline = Date().addingTimeInterval(5)
        while block.built == nil, Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertNotNil(block.built)
        block.interaction.onAction?("button", .message("Continue"))
        XCTAssertEqual(host.actions, [.message("Continue")])
        XCTAssertEqual(host.origins, ["origin"])
        for action: GenUIAction in [.plugin(id: "p"), .tool(name: "tool", input: .object([:])), .secret(.init(variables: [.init(name: "TOKEN")])), .open("https://user:pass@example.com")] {
            block.interaction.onAction?("blocked", action)
        }
        XCTAssertEqual(host.actions.count, 1)
        let repeated = GenUIMessageEmbed(agentId: "origin", toolCallId: "call", document: document, width: 361, environment: nil)
        XCTAssertTrue(embed.planner === repeated.planner)
        // When hosted on a device, keep a screenshot of this exact direct-message view.
        if let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
           let window = scene.windows.first {
            let previous = window.rootViewController
            window.rootViewController = host
            window.makeKeyAndVisible()
            window.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(250))
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
            let attachment = XCTAttachment(image: image)
            attachment.name = "Direct Gen UI message"
            attachment.lifetime = .keepAlways
            add(attachment)
            window.rootViewController = previous
        }
    }

    func testDirectResultHasMeasuredDocumentWithoutAnArtifactCard() throws {
        let folder = Bundle(for: Self.self).resourceURL!.appendingPathComponent("GenUI")
        let document = try XCTUnwrap(GenUIRenderDocument.parse(Data(contentsOf: folder.appendingPathComponent("01-stats.render.json"))))
        for width: CGFloat in [393, 700] {
            var key = ChatPlanner.Key(width: width, maxContentWidth: 10_000, environment: nil)
            key.agentId = "origin"
            let item = ChatItem(id: "message", role: .agent, pieces: [.genUI(toolCallId: "call", document: document)], delivery: .sent)
            let plan = ChatPlanner.plan(item, key: key, copied: false, syntax: CodeSyntaxService())
            let embeds = plan.items.compactMap { item -> (GenUIMessageEmbed, CGRect)? in
                if case .embed(.genUIMessage(let embed), let frame) = item { return (embed, frame) }
                return nil
            }
            let (embed, frame) = try XCTUnwrap(embeds.first)
            XCTAssertEqual(embeds.count, 1)
            XCTAssertEqual(embed.agentId, "origin")
            XCTAssertEqual(frame, CGRect(x: 16, y: 8, width: width - 32, height: embed.height))
            XCTAssertEqual(plan.size.height, frame.maxY + MessageLayout.Metrics.marginV)
            XCTAssertFalse(plan.hits.contains { if case .openArtifact = $0.action { true } else { false } })
            let view = ChatPlanView(frame: CGRect(origin: .zero, size: plan.size))
            view.apply(plan)
            let block = try XCTUnwrap(view.subviews.compactMap { $0 as? GenUIBlockView }.first)
            XCTAssertEqual(block.frame, frame)
            XCTAssertNil(block.conversationVersion)
            XCTAssertEqual(block.accessibilityIdentifier, "chat-gen-ui-message")
        }
    }
}

@MainActor
private final class MessageHost: UIViewController, PageHosting, GenUIMessageActing {
    let pageClient = AgentClient(transport: MessageOffline(), token: "test")
    var actions: [GenUIAction] = []
    var origins: [String] = []
    func page(_ artifactId: String, measured height: CGFloat) { XCTFail("unexpected artifact") }
    func genUIMessage(run action: GenUIAction, agentId: String) { actions.append(action); origins.append(agentId) }
}

private struct MessageOffline: AgentTransport {
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        XCTFail("Direct Gen UI fetched \(path)")
        throw URLError(.notConnectedToInternet)
    }
    func close() async {}
}
#endif