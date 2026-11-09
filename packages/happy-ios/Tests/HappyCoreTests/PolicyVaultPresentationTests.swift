import Foundation
import XCTest
@testable import HappyCore

final class PolicyVaultPresentationTests: XCTestCase {
    func testJoinedPolicyVaultUsesItsFlagRatherThanItsName() throws {
        let data = Data(#"""
        {"cursor":"c","profile":{"userId":"me"},"userSettings":[],"projects":[],"workspaces":[],
         "surfaces":[
          {"id":"policy","name":"Instructions","type":"vault","members":[{"userId":"me","orderKey":"a"}],"access":"write","policyVault":true},
          {"id":"ordinary","name":"Policy","type":"vault","members":[{"userId":"me","orderKey":"b"}],"access":"write"}]}
        """#.utf8)
        let rows = SidebarRows.make(try JSONDecoder().decode(DesktopSnapshot.self, from: data), settings: [:])
        XCTAssertEqual(rows.first { $0.targetId == "policy" }?.mark, .glyph(Rows.lockGlyph))
        XCTAssertEqual(rows.first { $0.targetId == "ordinary" }?.mark, .glyph("vault"))
    }

    func testPolicyVaultSpaceKeepsItsLock() {
        let surface = AgentWire.Surface(id: "policy", type: "vault", name: "Instructions", access: "write", policyVault: true)
        let space = AgentWire.Space(id: "s", title: surface.name, icon: nil, target: .init(kind: "surface", id: surface.id, agentId: nil, workspaceId: nil), version: 1, createdAt: 0, updatedAt: 0)
        XCTAssertEqual(Rows.mark(space, places: Places(surfaces: [surface])), .glyph(Rows.lockGlyph))
        XCTAssertTrue(surface.vaultAccess.canWrite(.open), "the icon does not make policy documents read-only")
    }

    func testRemoteSurfaceResultsPreservePolicyAndAccessLocks() throws {
        let result = try JSONDecoder().decode(Search.Result.self, from: Data(#"{"type":"surface","key":"surface:v","rank":1,"surfaceId":"v","surfaceType":"vault","name":"Policy"}"#.utf8))
        for (access, policy, glyph) in [("write", true, Rows.lockGlyph), ("none", false, Rows.lockGlyph), ("read", false, "vault")] {
            let surface = AgentWire.Surface(id: "v", type: "vault", name: "Policy", access: access, policyVault: policy)
            XCTAssertEqual(Search.shown(result, names: .init(surfaces: ["v": surface]))?.glyph, glyph)
        }
        XCTAssertEqual(Search.shown(result, names: .init())?.glyph, "vault", "a name is not policy metadata")
    }
}