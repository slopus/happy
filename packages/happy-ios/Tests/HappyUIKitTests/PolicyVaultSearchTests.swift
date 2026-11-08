#if canImport(UIKit)
import HappyCore
@testable import HappyUI
import XCTest

@MainActor
final class PolicyVaultSearchTests: XCTestCase {
    func testHomeSearchKeepsAnExistingSurfaceLock() {
        var row = Row(id: "surface:v", nodeId: "surface:v", kind: .space, label: "Instructions", mark: .glyph(Rows.lockGlyph), targetKind: "surface")
        row.surfaceType = "vault"
        XCTAssertEqual(HomeViewController.glyph(row), Rows.lockGlyph)
        row.mark = .none
        XCTAssertEqual(HomeViewController.glyph(row), "vault", "unknown metadata keeps the ordinary fallback")
    }

    func testProjectVisibilitySearchIsCloudSpecific() {
        XCTAssertFalse(SettingsIndex.computer(isCloud: true).contains { $0.id == "hide-projects" })
        XCTAssertTrue(SettingsIndex.computer(isCloud: false).contains { $0.id == "hide-projects" })
        XCTAssertEqual(SettingsIndex.computer(isCloud: true).map(\.id), SettingsIndex.computer.filter { $0.id != "hide-projects" }.map(\.id))
    }
}
#endif