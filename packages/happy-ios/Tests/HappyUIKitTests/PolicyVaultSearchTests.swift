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
        let cloud = SettingsIndex.computer(isCloud: true, computeAvailable: true).map(\.id)
        XCTAssertEqual(cloud.filter { ["computes", "zones", "secrets", "usage"].contains($0) }, ["computes", "zones", "secrets", "usage"])
        XCTAssertEqual(cloud.filter { !["computes", "zones", "secrets"].contains($0) }, SettingsIndex.computer.filter { $0.id != "hide-projects" }.map(\.id))
    }
}
#endif
