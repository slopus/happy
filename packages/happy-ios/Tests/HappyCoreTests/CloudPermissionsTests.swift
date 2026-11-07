import Foundation
import XCTest
@testable import HappyCore

/// A Happy Cloud server's roles: what `granted` lets the phone show, the
/// vaults' access, and the Policy vault's fixed folders and documents.
final class CloudPermissionsTests: XCTestCase {
    func testPermissionsReadOnlyGranted() throws {
        let json = #"{"role":"member","granted":["content.write","projects.manage"],"permissions":[{"id":"content.write","description":"Write"}]}"#
        let permissions = try JSONDecoder().decode(Permissions.self, from: Data(json.utf8))
        XCTAssertEqual(permissions.role, "member")
        XCTAssertTrue(permissions.allows(.contentWrite))
        XCTAssertFalse(permissions.allows(.botsManage))
    }

    func testAComputerGatesNothingAndACloudServerEverythingUntilRead() {
        XCTAssertTrue(RoleGate.open.allows(.contentWrite))
        XCTAssertTrue(RoleGate.open.allowsSending(toChiefOfStaff: true))
        XCTAssertFalse(RoleGate.cloud(nil).allows(.contentWrite), "permissions not read yet show nothing")
        XCTAssertFalse(RoleGate.cloud(nil).allowsSending(toChiefOfStaff: false))
    }

    func testOnlyARoleWithBotsManageWritesToTheChiefOfStaff() {
        let viewer = RoleGate.cloud(Permissions(role: "viewer", granted: []))
        let member = RoleGate.cloud(Permissions(role: "member", granted: ["content.write", "projects.manage"]))
        let owner = RoleGate.cloud(Permissions(role: "owner", granted: ["content.write", "projects.manage", "bots.manage"]))
        XCTAssertFalse(viewer.allowsSending(toChiefOfStaff: false))
        XCTAssertTrue(member.allowsSending(toChiefOfStaff: false))
        XCTAssertFalse(member.allowsSending(toChiefOfStaff: true))
        XCTAssertTrue(owner.allowsSending(toChiefOfStaff: true))
    }

    func testAVaultsAccessFromItsSurface() throws {
        let json = #"""
        {"surfaces":[
          {"id":"v1","type":"vault","name":"Policy","access":"read","policyVault":true,"accessPolicy":{"visibility":"listed","read":[],"write":[]}},
          {"id":"v2","type":"vault","name":"Secret","access":"none","policyVault":false},
          {"id":"v3","type":"vault","name":"Old"},
          {"id":"v4","type":"vault","name":"Odd","access":"admin"}]}
        """#
        struct Response: Decodable { let surfaces: [AgentWire.Surface] }
        let surfaces = try JSONDecoder().decode(Response.self, from: Data(json.utf8)).surfaces
        XCTAssertEqual(surfaces.map(\.vaultAccess), [
            VaultAccess(level: .read, policyVault: true),
            VaultAccess(level: .none),
            VaultAccess(level: .write),
            VaultAccess(level: .write),
        ])
        XCTAssertTrue(surfaces[1].vaultAccess.isLocked)
        XCTAssertEqual(Rows.surfaceGlyph("vault", access: "none"), Rows.lockGlyph)
        XCTAssertEqual(Rows.surfaceGlyph("vault", access: "read"), "vault")
    }

    func testWritingAVaultNeedsWriteAccessAndContentWrite() {
        let writer = RoleGate.cloud(Permissions(granted: ["content.write"]))
        let viewer = RoleGate.cloud(Permissions(granted: []))
        XCTAssertTrue(VaultAccess(level: .write).canWrite(writer))
        XCTAssertFalse(VaultAccess(level: .write).canWrite(viewer))
        XCTAssertFalse(VaultAccess(level: .read).canWrite(writer))
        XCTAssertTrue(VaultAccess(level: .write).canEditSettings(writer))
        XCTAssertFalse(VaultAccess(level: .write, policyVault: true).canEditSettings(writer), "the Policy vault's retention is fixed")
        XCTAssertTrue(VaultAccess().canWrite(.open))
    }

    func testThePolicyVaultsOwnFoldersAndDocumentsAreFixed() {
        let policy = VaultAccess(level: .write, policyVault: true)
        let global = VaultEntry(id: "g", surfaceId: "v", parentId: nil, name: "Global", kind: .folder)
        let notes = VaultEntry(id: "n", surfaceId: "v", parentId: nil, name: "Notes", kind: .folder)
        let agents = VaultEntry(id: "a", surfaceId: "v", parentId: "g", name: "AGENTS.md", kind: .file)
        let security = VaultEntry(id: "s", surfaceId: "v", parentId: "g", name: "SECURITY.md", kind: .file)
        let nested = VaultEntry(id: "x", surfaceId: "v", parentId: "n", name: "Global", kind: .folder)
        XCTAssertTrue(policy.isProtected(global, in: nil))
        XCTAssertFalse(policy.isProtected(notes, in: nil))
        XCTAssertFalse(policy.isProtected(nested, in: notes), "only the root's Global")
        XCTAssertTrue(policy.isProtected(agents, in: global))
        XCTAssertFalse(policy.isProtected(security, in: global), "SECURITY.md is fixed in Security only")
        XCTAssertTrue(policy.isProtected(security, in: nil, parentKnown: false), "opened from search, a fixed name is taken as fixed")
        XCTAssertFalse(VaultAccess(level: .write).isProtected(global, in: nil), "another vault's Global is anyone's")
    }

    func testABootstrapVaultSaysItsAccess() throws {
        let json = #"""
        {"cursor":"c","profile":{"userId":"me"},"userSettings":[],"projects":[],"workspaces":[],
         "surfaces":[{"id":"v","name":"Secret","type":"vault","members":[{"userId":"me","orderKey":"a"}],"access":"none","policyVault":false}]}
        """#
        let desktop = try JSONDecoder().decode(DesktopSnapshot.self, from: Data(json.utf8))
        XCTAssertEqual(desktop.surfaces?.first?.access, "none")
        let row = SidebarRows.make(desktop, settings: [:]).first { $0.targetId == "v" }
        XCTAssertEqual(row?.mark, .glyph(Rows.lockGlyph))
    }

    func testForbiddenIsARolesRefusal() {
        XCTAssertTrue(AgentClientError.status(403, code: "forbidden", message: "This needs the content.write permission.").isForbidden)
        XCTAssertFalse(AgentClientError.status(403, code: nil, message: nil).isForbidden)
        XCTAssertFalse(AgentClientError.status(404, code: "forbidden", message: nil).isForbidden)
    }
}
