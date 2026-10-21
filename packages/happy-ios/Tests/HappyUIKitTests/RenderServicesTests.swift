#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// Plans draw with the account's documents and colour, and once the
/// account has stopped they draw nothing rather than something wrong.
@MainActor
final class RenderServicesTests: XCTestCase {
    private func section(_ old: String, _ new: String, render: RenderServices) -> DiffSectionPlan {
        let item = DiffFileItem(path: "a.swift", kind: .modified, additions: 1, deletions: 1, source: .contents(path: "a.swift", oldText: old, newText: new))
        let input = DiffSectionInput(item: item, collapsed: false, sizeHint: nil, canExpandContext: false, expandedFiles: [], words: DiffSectionWords())
        return DiffSectionPlan(input, width: 393, scale: 3, render: render)
    }

    func testAnOpenFileOfAStoppedAccountShowsNothingRatherThanNoChanges() {
        let live = RenderServices.isolated()
        guard case .files(let files) = section("let a = 1", "let a = 2", render: live).body else { return XCTFail("a diff") }
        XCTAssertEqual(files.count, 1)
        guard case .message = section("same", "same", render: live).body else { return XCTFail("no changes") }

        let stopped = RenderServices.isolated()
        stopped.diffDocuments.close()
        stopped.diffSyntax.close()
        stopped.codeSyntax.close()
        guard case .none = section("let a = 1", "let a = 2", render: stopped).body else { return XCTFail("nothing, not \"No changes\"") }
        XCTAssertNil(ChatRowRenderer.diffPiece(
            ToolDiffChunk(oldText: "let a = 1", newText: "let a = 2", fileName: "a.swift"),
            index: 0, toolId: "t", showLineNumbers: false, expanded: [], render: stopped, text: .designed
        ))
    }

    /// Screens drop a landing plan by this, while the stopping account is
    /// still the open one; any one owner closed makes the plan stale.
    func testServicesAreClosedOnceAnyOwnerIs() {
        for close in [\RenderServices.diffDocuments, \.diffSyntax, \.codeSyntax] as [PartialKeyPath<RenderServices>] {
            let render = RenderServices.isolated()
            XCTAssertFalse(render.isClosed)
            switch render[keyPath: close] {
            case let owner as DiffDocumentCache: owner.close()
            case let owner as DiffSyntaxService: owner.close()
            case let owner as CodeSyntaxService: owner.close()
            default: XCTFail("an owner")
            }
            XCTAssertTrue(render.isClosed)
        }
    }

    func testServicesAreEqualOnlyWhenTheyAreTheSameAccounts() {
        let one = RenderServices.isolated()
        XCTAssertEqual(one, one)
        XCTAssertNotEqual(one, RenderServices.isolated())
    }
}
#endif
