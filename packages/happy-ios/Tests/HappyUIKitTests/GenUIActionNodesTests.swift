#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyWire
@testable import HappyUI
import UIKit
import UltraView
import XCTest

/// happy-agent's `docs/genui/render/conformance/actions.json` as nodes:
/// each host taps only what it enables, draws the rest disabled, keeps
/// every element, and lays the document out the same for every host.
@MainActor
final class GenUIActionNodesTests: XCTestCase {
    private var folder: URL { Bundle(for: Self.self).resourceURL!.appendingPathComponent("GenUI") }

    private static let hosts: [String: GenUIRuns] = [
        "happy_agent": GenUIRuns(host: GenUIHost(server: .happyAgent, origin: true, secretActions: true, plugins: true), sends: true, forms: true),
        "happy_agent_without_origin": GenUIRuns(host: GenUIHost(server: .happyAgent, origin: false, secretActions: true, plugins: true), sends: true, forms: true),
        "cluster": GenUIRuns(host: GenUIHost(server: .cluster, origin: true, secretActions: true, plugins: true), sends: true, forms: true),
    ]

    private func conformance() throws -> (GenUIRenderDocument, JSONValue) {
        let file = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: folder.appendingPathComponent("conformance/actions.json")))
        return (try XCTUnwrap(file["document"].flatMap(GenUIRenderDocument.parse)), file)
    }

    /// Every node VoiceOver reads as one element, by label, with whether it
    /// takes a tap and whether it says it is unavailable.
    private func elements(_ node: UltraNode) -> [(label: String, taps: Bool, unavailable: Bool)] {
        let own: [(label: String, taps: Bool, unavailable: Bool)] = node.accessibility.isElement == true || node.accessibility.role == .button
            ? [(node.accessibility.label ?? "", node.onPress != nil, node.accessibility.hint == "Unavailable here")] : []
        return own + node.children.flatMap(elements)
    }

    /// What an element is read as: a button its label, a press its text.
    private func label(_ element: String, in source: JSONValue) -> String {
        let props = source["elements"]?[element]?["props"]
        if let label = props?["label"]?.stringValue { return label }
        let child = source["elements"]?[element]?["children"]?.arrayValue?.first?.stringValue ?? ""
        return source["elements"]?[child]?["props"]?["spans"]?.arrayValue?.first?["text"]?.stringValue ?? ""
    }

    func testEachHostTapsOnlyWhatItEnables() throws {
        let (document, file) = try conformance()
        let source = try XCTUnwrap(file["document"])
        let plan = GenUIPlanner(document: document, traits: GenUITraits(text: nil, displayScale: 3)).plan(width: 358)
        let cases = try XCTUnwrap(file["cases"]?.arrayValue)
        for (name, runs) in Self.hosts {
            let built = GenUINodeBuilder.build(plan, interaction: GenUIInteraction(), dark: false, runs: runs)
            let drawn = elements(built.root)
            XCTAssertEqual(drawn.count, cases.count, "\(name): nothing is dropped")
            for item in cases {
                let element = try XCTUnwrap(item["element"]?.stringValue)
                let enabled = try XCTUnwrap(item["enabled"]?[name]?.boolValue)
                let label = label(element, in: source)
                let matches = drawn.filter { $0.label == label }
                XCTAssertFalse(matches.isEmpty, "\(element) drawn on \(name)")
                // Labels shared by several elements are all of disabled ones.
                for match in matches {
                    XCTAssertEqual(match.taps, enabled, "\(element) on \(name)")
                    let isButton = source["elements"]?[element]?["type"]?.stringValue == "button"
                    XCTAssertEqual(match.unavailable, isButton && !enabled, "\(element) on \(name) says so")
                }
            }
        }
    }

    func testAScreenWithoutTheMeansDisablesWhatTheHostAllows() throws {
        let (document, _) = try conformance()
        let plan = GenUIPlanner(document: document, traits: GenUITraits(text: nil, displayScale: 3)).plan(width: 358)
        let host = GenUIHost(server: .happyAgent, origin: true, secretActions: true, plugins: true)
        // Not the origin's conversation, and no secret form yet.
        let drawn = elements(GenUINodeBuilder.build(plan, interaction: GenUIInteraction(), dark: false, runs: GenUIRuns(host: host, sends: false)).root)
        XCTAssertEqual(drawn.first { $0.label == "Ask for a summary" }?.taps, false)
        XCTAssertEqual(drawn.first { $0.label == "Add Stripe keys" }?.taps, false)
        XCTAssertEqual(drawn.first { $0.label == "Open the PR" }?.taps, true)
        XCTAssertEqual(drawn.first { $0.label == "Get the Linear plugin" }?.taps, true)
    }

    func testATapReportsTheElementAndItsAction() throws {
        let (document, _) = try conformance()
        let plan = GenUIPlanner(document: document, traits: GenUITraits(text: nil, displayScale: 3)).plan(width: 358)
        let interaction = GenUIInteraction()
        var reported: [(String, GenUIAction)] = []
        interaction.onAction = { reported.append(($0, $1)) }
        let built = GenUINodeBuilder.build(plan, interaction: interaction, dark: false, runs: .reporting)
        func find(_ node: UltraNode, _ label: String) -> UltraNode? {
            node.accessibility.label == label ? node : node.children.lazy.compactMap { find($0, label) }.first
        }
        try XCTUnwrap(find(built.root, "Get the Linear plugin")?.onPress)()
        try XCTUnwrap(find(built.root, "Copy the command")?.onPress)()
        XCTAssertEqual(reported.map(\.0), ["plugin", "copy"])
        XCTAssertEqual(reported.map(\.1), [.plugin(id: "linear"), .copy("pnpm test")])
    }

    /// A saved secret button keeps its label, its colours and its frame;
    /// its leading glyph, a lock where it named none, turns to a check,
    /// and VoiceOver hears "Saved". An unsaved one is drawn as it was.
    func testASavedSecretButtonKeepsItsLookAndTakesACheck() throws {
        let (document, _) = try conformance()
        let plan = GenUIPlanner(document: document, traits: GenUITraits(text: nil, displayScale: 3)).plan(width: 358)
        let icon = try XCTUnwrap(plan.root.flattened().first { $0.placed.key == "secret.icon" }, "a secret button names no icon: a lock")
        guard case .glyph("lock", _, _) = icon.placed.mark else { return XCTFail("\(icon.placed.mark)") }
        let interaction = GenUIInteraction()
        let built = GenUINodeBuilder.build(plan, interaction: interaction, dark: false, runs: .reporting)
        var redrawn = 0
        interaction.redraw = { redrawn += 1 }
        interaction.adopt(built.choices, secrets: built.secrets)
        let secret = try XCTUnwrap(built.secrets["secret"])
        guard case .button(let glyph?) = secret.look else { return XCTFail("no glyph to check") }
        let before = (secret.node.style.backgroundColor, secret.node.style.borderColor, secret.node.style.borderWidth)
        XCTAssertFalse(glyph.isSaved)
        interaction.save("secret", secret: "stripe")
        XCTAssertTrue(glyph.isSaved)
        XCTAssertEqual(redrawn, 1)
        XCTAssertEqual(secret.node.accessibility.label, "Add Stripe keys")
        XCTAssertEqual(secret.node.accessibility.hint, "Saved")
        XCTAssertEqual(secret.node.style.backgroundColor, before.0)
        XCTAssertEqual(secret.node.style.borderColor, before.1)
        XCTAssertEqual(secret.node.style.borderWidth, before.2)
        // Built again (another width, the other appearance), it is still saved.
        let again = GenUINodeBuilder.build(plan, interaction: interaction, dark: true, runs: .reporting)
        interaction.adopt(again.choices, secrets: again.secrets)
        guard case .button(let rebuilt?) = try XCTUnwrap(again.secrets["secret"]).look else { return XCTFail("no glyph") }
        XCTAssertTrue(rebuilt.isSaved)
    }
}
#endif
