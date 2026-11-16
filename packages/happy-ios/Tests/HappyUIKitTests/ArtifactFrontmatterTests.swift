#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit
import XCTest
@testable import HappyUI

/// A Markdown artifact that opens with YAML frontmatter draws it as a
/// `yaml` code block, not as a rule over a heading of every YAML line; a
/// conversation's message that opens with a rule is left as it was.
@MainActor
final class ArtifactFrontmatterTests: XCTestCase {
    private let yaml = """
    name: alexa_smart_home_get_device
    input:
      endpointId:
        type: string
        pattern: ^amzn1.alexa.endpoint.[A-Za-z0-9-]+$
        description: Alexa endpoint id, e.g. 'amzn1.alexa.endpoint.<uuid>'.
    """

    private let body = """

    Read the live state of one Alexa smart-home device
    by its endpoint id.

    ---

    A rule further down is still a rule.
    """

    private let key = ChatPlanner.Key(width: 393, maxContentWidth: 10_000, environment: nil)

    private func document(_ markdown: String) -> ChatRowPlan {
        ArtifactViewController.plan(ArtifactMarkdown.prepare(markdown), id: "artifact:a1:SKILL.md", key: key, syntax: CodeSyntaxService(), document: MarkdownDocument(pictures: [:]))
    }

    private func message(_ markdown: String) -> ChatRowPlan {
        ChatPlanner.plan(ChatItem(id: "m1", role: .agent, pieces: [.text(markdown)], delivery: .sent), key: key, copied: false, syntax: CodeSyntaxService())
    }

    /// With `HAPPY_PREVIEW_DIR` set, what the document draws, as a PNG to look at.
    private func preview(_ plan: ChatRowPlan, _ name: String) {
        guard let directory = ProcessInfo.processInfo.environment["HAPPY_PREVIEW_DIR"] else { return }
        let view = ChatPlanView(frame: CGRect(origin: .zero, size: plan.size))
        view.backgroundColor = UIColor(Palette.surface)
        view.apply(plan)
        view.layoutIfNeeded()
        let format = UIGraphicsImageRendererFormat()
        format.scale = 3
        let image = UIGraphicsImageRenderer(bounds: view.bounds, format: format).image { context in
            view.layer.setNeedsDisplay()
            view.layer.displayIfNeeded()
            view.layer.render(in: context.cgContext)
        }
        try? image.pngData()?.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name).png"))
    }

    func testADocumentsFrontmatterDrawsAsItsFencedYaml() {
        let plan = document("---\n\(yaml)\n---\n\(body)")
        preview(plan, "artifact-frontmatter")
        let fenced = document("```yaml\n\(yaml)\n```\n\(body)")
        XCTAssertEqual(plan.size, fenced.size)
        XCTAssertEqual(plan.items.count, fenced.items.count)
    }

    func testAMessageThatOpensWithARuleIsAsBefore() {
        let text = "---\n\(yaml)\n---\n\(body)"
        let plan = message(text)
        preview(plan, "message-opening-rule")
        XCTAssertNotEqual(plan.size, message("```yaml\n\(yaml)\n```\n\(body)").size)
    }
}
#endif
