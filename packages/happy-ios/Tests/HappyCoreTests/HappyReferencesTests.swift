import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// Reference tags found exactly where the reference `parseHappyReferences`
/// finds them (`scripts/generate-reference-fixtures.ts`), settled and
/// streaming, and how a message reads with them.
final class HappyReferencesTests: XCTestCase {
    private static let vectors: JSONValue = {
        let url = Bundle.module.url(forResource: "happy-references", withExtension: "json", subdirectory: "Fixtures")!
        return try! JSONValue.decode(Data(contentsOf: url))
    }()

    private static func expected(_ segments: JSONValue) -> [String] {
        segments.arrayValue!.map { segment in
            guard segment["type"]!.stringValue! == "reference" else { return "T:" + segment["text"]!.stringValue! }
            let reference = segment["reference"]!
            let version = reference["version"]?.numberValue.map { " v\(Int($0))" } ?? ""
            let workspace = reference["workspaceId"]?.stringValue.map { " w\($0)" } ?? ""
            return "R:\(reference["kind"]!.stringValue!)/\(reference["id"]!.stringValue!)\(version)\(workspace) \(segment["source"]!.stringValue!)"
        }
    }

    private static func actual(_ segments: [HappyReferences.Segment]) -> [String] {
        segments.map { segment in
            switch segment {
            case .text(let text): "T:" + text
            case .reference(let reference, let source):
                "R:\(reference.kind)/\(reference.id)\(reference.version.map { " v\($0)" } ?? "")\(reference.workspaceId.map { " w\($0)" } ?? "") \(source)"
            }
        }
    }

    func testParsesAsTheReference() {
        let cases = Self.vectors["cases"]!.arrayValue!
        XCTAssertGreaterThan(cases.count, 400)
        for (index, entry) in cases.enumerated() {
            let text = entry["text"]!.stringValue!
            XCTAssertEqual(Self.actual(HappyReferences.parse(text)), Self.expected(entry["settled"]!), "case \(index): \(text.debugDescription)")
            XCTAssertEqual(Self.actual(HappyReferences.parse(text, streaming: true)), Self.expected(entry["streaming"]!), "case \(index) streaming: \(text.debugDescription)")
        }
    }

    /// The bots and tasks as the store holds them: a bot whose agent has a
    /// subtask with its own workspace, and a task.
    private static let owners: [JSONValue] = [
        .object(["name": .string("Chef"), "workspaceId": .string("wb"), "agent": .object([
            "id": .string("ab"), "workspaceId": .string("wb"), "title": .string("Chief of Staff chat"),
            "subtasks": .array([.object(["id": .string("as"), "workspaceId": .string("ws"), "title": .string("Guest list template"), "subtasks": .array([
                .object(["id": .string("ag"), "workspaceId": .string("ws"), "title": .string("  ")]),
            ])])]),
        ])]),
        .object(["name": .string("Birthday party for Maya"), "workspaceId": .string("wt"), "agent": .object(["id": .string("at"), "subtasks": .array([])])]),
    ]

    private func markdown(_ text: String, _ references: StemCellReferences) -> String {
        HappyReferences.markdown(text, view: references.view).replacingOccurrences(of: HappyReferences.linkPrefix, with: "ref:")
    }

    func testAnAgentReadsAsItsConversationsName() {
        let references = StemCellReferences.entities(owners: Self.owners)
        // A bot's or task's own agent by the bot's or task's name; a subtask by its title.
        XCTAssertEqual(markdown("<happy-agent id=\"ab\"/>", references), "[Chef](ref:agent/ab)")
        XCTAssertEqual(markdown("<happy-agent id=\"at\"/>", references), "[Birthday party for Maya](ref:agent/at)")
        XCTAssertEqual(markdown("Started <happy-agent id=\"as\"/> to draft it.", references), "Started [Guest list template](ref:agent/as) to draft it.")
        // A subtask without a name yet, and one the lists don't hold (archived).
        XCTAssertEqual(markdown("<happy-agent id=\"ag\"/>", references), "[Untitled agent](ref:agent/ag)")
        XCTAssertEqual(markdown("<happy-agent id=\"gone\"/>", references), "an unavailable agent")
        XCTAssertEqual(references.entity(.init(kind: "agent", id: "as")), .init(label: "Guest list template", agentId: "as"))
    }

    func testAHiddenSubagentReadsAsItsTitleAndOpensNothing() {
        var references = StemCellReferences.entities(owners: Self.owners)
        references.subagents = ["c1": "Find flights", "c2": " ", "as": "Not this"]
        XCTAssertEqual(markdown("Dispatched to <happy-agent id=\"c1\"/>.", references), "Dispatched to Find flights.")
        XCTAssertEqual(markdown("<happy-agent id=\"c2\"/>", references), "Subagent")
        // A subtask the lists hold still opens as itself.
        XCTAssertEqual(markdown("<happy-agent id=\"as\"/>", references), "[Guest list template](ref:agent/as)")
        XCTAssertNil(references.entity(.init(kind: "agent", id: "c1")))
    }

    func testAWorkspaceReadsAsWhatItHolds() {
        let references = StemCellReferences.entities(owners: Self.owners)
        XCTAssertEqual(markdown("<happy-workspace id=\"wb\"/>", references), "[Chef](ref:workspace/wb)")
        XCTAssertEqual(markdown("<happy-workspace id=\"wt\"/>", references), "[Birthday party for Maya](ref:workspace/wt)")
        // A subtask's own workspace by the first subtask in it.
        XCTAssertEqual(markdown("<happy-workspace id=\"ws\"/>", references), "[Guest list template](ref:workspace/ws)")
        XCTAssertEqual(references.entity(.init(kind: "workspace", id: "wb"))?.agentId, "ab")
        XCTAssertEqual(markdown("<happy-workspace id=\"nope\"/>", references), "an unavailable workspace")
    }

    func testAnArtifactReadsAsItsTitleOnceRead() {
        var references = StemCellReferences()
        let text = "See <happy-artifact id=\"r1\" version=\"2\"/>."
        XCTAssertEqual(references.unread(in: text), ["r1"])
        XCTAssertEqual(markdown(text, references), "See [artifact](ref:artifact/r1/2).", "reading")
        references.artifacts["r1"] = StemCellReferences.artifact(.object(["title": .string("Q3 revenue report"), "status": .string("active"), "type": .string("markdown"), "latestVersion": .number(2)]))
        XCTAssertEqual(references.unread(in: text), [])
        XCTAssertEqual(markdown(text, references), "See [Q3 revenue report](ref:artifact/r1/2).")
        references.artifacts["r1"] = .active(title: " ", type: "html", latestVersion: 1)
        XCTAssertEqual(markdown(text, references), "See [Untitled artifact](ref:artifact/r1/2).")
        // Deleted: named, not offered. Missing: words that say so.
        references.artifacts["r1"] = StemCellReferences.artifact(.object(["title": .string("Old report"), "status": .string("deleted")]))
        XCTAssertEqual(markdown(text, references), "See Old report.")
        references.artifacts["r1"] = .missing
        XCTAssertEqual(markdown(text, references), "See an unavailable artifact.")
    }

    func testProjectsServicesAndUnknownKindsAreInert() {
        let references = StemCellReferences.entities(owners: Self.owners)
        XCTAssertEqual(markdown("<happy-project id=\"p\"/> <happy-service id=\"s\" workspace=\"wb\"/> <happy-gizmo id=\"g\"/>", references),
                       "an unavailable project an unavailable service an unavailable reference")
    }

    func testNamesAreRunningWordsAndOnlyThisPhonesLinksOpen() {
        let references = StemCellReferences(agents: ["a1": .init(label: "Guest *list* [draft]\nnow", agentId: "a1")])
        let text = "Started <happy-agent id=\"a1\"/> to draft the [guest] list, not `<happy-agent id=\"a1\"/>`."
        XCTAssertEqual(markdown(text, references), "Started [Guest list (draft) now](ref:agent/a1) to draft the [guest] list, not `<happy-agent id=\"a1\"/>`.")
        XCTAssertEqual(HappyReferences.plain(text, view: references.view), "Started Guest *list* [draft]\nnow to draft the [guest] list, not `<happy-agent id=\"a1\"/>`.")
        XCTAssertEqual(HappyReferences.reference(link: HappyReferences.link(.init(kind: "agent", id: "a1"))), .init(kind: "agent", id: "a1"))
        // A pinned version survives the link.
        XCTAssertEqual(HappyReferences.reference(link: HappyReferences.link(.init(kind: "artifact", id: "r", version: 3))), .init(kind: "artifact", id: "r", version: 3))
        XCTAssertNil(HappyReferences.reference(link: HappyReferences.linkPrefix + "artifact/r/0"))
        XCTAssertNil(HappyReferences.reference(link: "happy-reference:agent/a1"), "a hand-written link passed for a reference")
    }

    func testStreamingHoldsBackATagStillArriving() {
        XCTAssertEqual(HappyReferences.droppingPartialTag("Started <happy-agent id=\"a"), "Started ")
        XCTAssertEqual(HappyReferences.droppingPartialTag("1 < 2"), "1 < 2")
        XCTAssertEqual(HappyReferences.droppingPartialTag("Done <happy-agent id=\"a\"/>"), "Done <happy-agent id=\"a\"/>")
    }
}
