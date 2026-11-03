#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// A Happy Agent slash command's row: its picture's thumbhash at once over
/// the kind's mark, the kind on the right, and all of it read aloud.
@MainActor
final class AgentCommandRowTests: XCTestCase {
    func testACommandWithAPictureShowsItsThumbhash() {
        let row = self.row(AgentWire.SlashCommand(
            name: "code-review", hasArguments: true, description: "Review the change",
            kind: "skill", image: .init(thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI")
        ))

        XCTAssertEqual(row.accessibilityLabel, "/code-review, Review the change, Skill")
        XCTAssertEqual(pictures(in: row).count, 1)
        XCTAssertEqual(pictures(in: row).first?.frame, CGRect(x: 16, y: 8, width: 32, height: 32))
        XCTAssertTrue(labels(in: row).contains("Skill"))
    }

    func testACommandWithoutAPictureOrKindShowsTheMarkAlone() {
        let row = self.row(AgentWire.SlashCommand(
            name: "context", hasArguments: false, description: "", kind: nil, image: nil
        ))

        XCTAssertEqual(row.accessibilityLabel, "/context")
        XCTAssertTrue(pictures(in: row).isEmpty)
        XCTAssertEqual(labels(in: row), ["/context"])
    }

    func testEachKindWearsItsMark() {
        XCTAssertEqual(ComposerSuggestionRowView.glyph("skill"), .ionicons("sparkles-outline"))
        XCTAssertEqual(ComposerSuggestionRowView.glyph("compaction"), .ionicons("funnel-outline"))
        XCTAssertEqual(ComposerSuggestionRowView.glyph("release"), .ionicons("flash-outline"))
        XCTAssertEqual(ComposerSuggestionRowView.glyph(nil), .ionicons("flash-outline"))
    }

    private func row(_ command: AgentWire.SlashCommand) -> ComposerSuggestionRowView {
        let list = ComposerSuggestionListView()
        list.set(SlashCommands.suggestions("", in: [command], agentId: "agent-1"), selected: 0)
        list.frame = CGRect(x: 0, y: 0, width: 361, height: 49)
        list.layoutIfNeeded()
        let row = list.hitTest(CGPoint(x: 100, y: 24), with: nil) as? ComposerSuggestionRowView
        XCTAssertNotNil(row)
        row?.layoutIfNeeded()
        return row ?? ComposerSuggestionRowView()
    }

    private func pictures(in row: UIView) -> [UIImageView] {
        row.subviews.compactMap { $0 as? UIImageView }.filter { !$0.isHidden && $0.image != nil }
    }

    private func labels(in row: UIView) -> [String] {
        row.subviews.compactMap { $0 as? UILabel }.filter { !$0.isHidden }.compactMap(\.text).filter { !$0.isEmpty }
    }
}
#endif
