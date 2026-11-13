#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import UltraView
import XCTest

/// A `gen_ui` artifact a call shows in a conversation: its card, then its
/// document under it, as tall as the document plans at the column's width
/// on the row's first plan, and drawn from that same plan.
@MainActor
final class GenUIChatEmbedTests: XCTestCase {
    private var folder: URL { Bundle(for: Self.self).resourceURL!.appendingPathComponent("GenUI") }

    private func document(_ name: String) throws -> GenUIRenderDocument {
        try XCTUnwrap(GenUIRenderDocument.parse(Data(contentsOf: folder.appendingPathComponent("\(name).render.json"))))
    }

    private func embeds(_ plan: ChatRowPlan) -> [(GenUIEmbed, CGRect)] {
        plan.items.compactMap { if case .embed(.genUI(let embed), let frame) = $0 { (embed, frame) } else { nil } }
    }

    private func plan(_ artifact: Artifact, _ key: ChatPlanner.Key) -> ChatRowPlan {
        ChatPlanner.plan(ChatItem(id: "m-\(artifact.version)-\(artifact.followsLatest)", role: .agent, pieces: [.artifact(artifact)], delivery: .sent), key: key, copied: false, syntax: CodeSyntaxService())
    }

    // Planners are kept by artifact and version, which never change their
    // document: each test names its own artifacts.
    func testTheDocumentSitsUnderItsCardAtItsPlannedHeightOnTheFirstPlan() throws {
        let artifact = Artifact(id: "art1", version: 1, type: "gen_ui", title: "Q3 at a glance", followsLatest: true)
        var key = ChatPlanner.Key(width: 393, maxContentWidth: 10_000, environment: nil)
        // Not read yet: the card alone.
        XCTAssertTrue(embeds(plan(artifact, key)).isEmpty)

        let stats = try document("01-stats")
        key.references.genUI["art1"] = .init(version: 2, document: stats)
        let planned = plan(artifact, key)
        let (embed, frame) = try XCTUnwrap(embeds(planned).first)
        let height = GenUIPlanner(document: stats, traits: GenUITraits(text: nil, displayScale: 2)).height(width: 361)
        XCTAssertGreaterThan(height, 200)
        XCTAssertEqual(embed.version, 2)
        XCTAssertEqual(frame, CGRect(x: 16, y: 8 + ResultCardLayout.height + 8, width: 361, height: height))
        XCTAssertEqual(planned.size.height, frame.maxY + MessageLayout.Metrics.marginV)
        // The card still opens the artifact whole.
        XCTAssertTrue(planned.hits.contains { if case .openArtifact = $0.action { true } else { false } })

        // Planned again, or by another row: the same planner, its plan made once.
        let again = try XCTUnwrap(embeds(plan(artifact, key)).first?.0)
        XCTAssertTrue(again.planner === embed.planner)
        XCTAssertEqual(again, embed)

        // A call that recorded an older version is a card; one that names the latest draws it.
        var recorded = Artifact(id: "art1", version: 1, type: "gen_ui", title: "", followsLatest: false)
        recorded.pinned = true
        XCTAssertTrue(embeds(plan(recorded, key)).isEmpty)
        var named = Artifact(id: "art1", version: 2, type: "gen_ui", title: "", followsLatest: false)
        named.pinned = true
        XCTAssertEqual(embeds(plan(named, key)).count, 1)

        // A wider column plans again at its width.
        key.width = 700
        XCTAssertEqual(embeds(plan(artifact, key)).first?.1.width, 700 - 32)
    }

    func testTheRowDrawsTheDocumentFromThePlanItWasSizedBy() async throws {
        var key = ChatPlanner.Key(width: 393, maxContentWidth: 10_000, environment: nil)
        key.references.genUI["choices1"] = .init(version: 2, document: try document("10-choices"))
        let planned = plan(Artifact(id: "choices1", version: 2, type: "gen_ui", title: "Pick one", followsLatest: true), key)
        let (embed, frame) = try XCTUnwrap(embeds(planned).first)

        let view = ChatPlanView(frame: CGRect(origin: .zero, size: planned.size))
        view.apply(planned)
        let block = try XCTUnwrap(view.subviews.compactMap { $0 as? GenUIBlockView }.first)
        XCTAssertEqual(block.frame, frame)
        let deadline = Date().addingTimeInterval(5)
        while block.built == nil, Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
        let built = try XCTUnwrap(block.built)
        XCTAssertTrue(built.plan.root.frame.size == embed.planner.plan(width: 361).root.frame.size)
        XCTAssertEqual(built.plan.size.height, frame.height)

        // An answer is the view's own; the same document planned again keeps it, another one starts afresh.
        built.choices["choices.1"]?.node.onPress?()
        XCTAssertEqual(block.interaction.chosen, ["choices": "choices.1"])
        view.apply(planned)
        XCTAssertTrue(block.built.map { $0.root === built.root } ?? false, "nothing rebuilt")
        XCTAssertEqual(block.interaction.chosen, ["choices": "choices.1"])
        key.references.genUI["choices2"] = .init(version: 1, document: try document("10-choices"))
        view.apply(plan(Artifact(id: "choices2", version: 1, type: "gen_ui", title: "Pick again", followsLatest: true), key))
        XCTAssertEqual(block.interaction.chosen, [:])
    }
}
#endif
