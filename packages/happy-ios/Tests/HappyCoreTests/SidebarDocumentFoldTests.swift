@testable import HappyCore
import XCTest

/// A Surface row's glyph, and a nested row's fold in the sidebar document.
final class SidebarDocumentFoldTests: XCTestCase {
    func testASurfaceRowWearsItsKindsGlyph() {
        XCTAssertEqual(Rows.surfaceGlyph("todo"), "tasks")
        XCTAssertEqual(Rows.surfaceGlyph("document"), "doc")
        XCTAssertEqual(Rows.surfaceGlyph("calendar"), "calendar")
        XCTAssertEqual(Rows.surfaceGlyph("system_monitor"), "pulse")
        XCTAssertEqual(Rows.surfaceGlyph("chat"), "users")
        XCTAssertEqual(Rows.surfaceGlyph(nil), "doc")
    }

    /// A nested row folds as a top-level one does: one `set` of its own `expanded`.
    func testANestedRowFoldsByItself() throws {
        let document = try SpaceSidebar.parse(#"<nav><happy-search/><happy-create/><happy-space id="t" expanded="true"><happy-space id="s1"><happy-space id="g1"/></happy-space><happy-space id="s2"/></happy-space></nav>"#)
        let opened = try XCTUnwrap(SidebarDocumentEdits.fold(document, "s1"))
        XCTAssertEqual(try SpaceSidebar.diff(document, opened), [.set(SpaceSidebarSet(id: "s1", expanded: true))])
        let closed = try XCTUnwrap(SidebarDocumentEdits.fold(opened, "s1"))
        XCTAssertEqual(try SpaceSidebar.diff(opened, closed), [.set(SpaceSidebarSet(id: "s1", expanded: false))])
    }
}
