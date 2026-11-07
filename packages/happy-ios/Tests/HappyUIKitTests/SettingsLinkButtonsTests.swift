#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyWire
import UIKit
import XCTest
@testable import HappyUI

/// Happy links titled `button` in an agent's message (API.md, "Buttons"):
/// full-width buttons under their paragraph that open what the link
/// names, or the label as words where the link opens nothing here.
@MainActor
final class SettingsLinkButtonsTests: XCTestCase {
    private let text = """
    Add a provider to start. [Add your team's tokens](happy://settings/providers "button") [Settings](happy://settings/general "button")

    Or see [general settings](happy://settings/general).
    """

    private func plan(server: String?) -> ChatRowPlan {
        var key = ChatPlanner.Key(width: 393, maxContentWidth: 10_000, environment: nil)
        key.server = server
        let item = ChatItem(id: "m1", role: .agent, pieces: [.text(text)], delivery: .sent)
        return ChatPlanner.plan(item, key: key, copied: false, syntax: CodeSyntaxService())
    }

    private func buttons(_ plan: ChatRowPlan) -> [ChatRowAction] {
        plan.hits.map(\.action).filter { if case .linkButton = $0 { true } else { false } }
    }

    /// With `HAPPY_PREVIEW_DIR` set, what the message draws, as a PNG to look at.
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

    func testOnACloudServerEveryPageIsAButton() {
        let plan = plan(server: "https://acme.happy-clusters.com")
        preview(plan, "settings-buttons-cloud")
        XCTAssertEqual(buttons(plan), [
            .linkButton(url: "happy://settings/providers", label: "Add your team's tokens"),
            .linkButton(url: "happy://settings/general", label: "Settings"),
        ])
    }

    func testAPageThePhoneHasNowhereForIsItsWords() {
        let plan = plan(server: nil)
        preview(plan, "settings-buttons-computer")
        XCTAssertEqual(buttons(plan), [.linkButton(url: "happy://settings/general", label: "Settings")])
        XCTAssertTrue((plan.accessibilityLabel ?? "").contains("Add your team's tokens"))
    }
}
#endif
