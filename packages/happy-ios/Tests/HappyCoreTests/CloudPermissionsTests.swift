import Foundation
import XCTest
@testable import HappyCore

/// A Happy Cloud server's teams: what `granted` lets the phone show, the
/// vaults' access, and the Policy vault's fixed folders and documents.
final class CloudPermissionsTests: XCTestCase {
    func testPermissionsAreReadWithTheOwnerFlagAndTeams() throws {
        let json = #"""
        {"owner":false,"teams":["members","design",7],"granted":["content.write","projects.manage"],"role":"design",
         "permissions":[{"id":"content.write","description":"Write","member":true,"ownerOnly":false}]}
        """#
        let permissions = try JSONDecoder().decode(Permissions.self, from: Data(json.utf8))
        XCTAssertFalse(permissions.owner)
        XCTAssertEqual(permissions.teams, ["members", "design"], "a team it can't read is left out")
        XCTAssertTrue(permissions.allows(.contentWrite))
        XCTAssertFalse(permissions.allows(.botsManage))
        XCTAssertTrue(permissions.knows(.contentWrite))
    }

    /// Only `granted` decides: an owner is shown as one, but what they
    /// may do is still what the server granted.
    func testAnOwnerIsGrantedWhatTheServerSays() throws {
        let json = #"{"owner":true,"teams":["members","owners"],"granted":["content.write"],"role":"owner"}"#
        let permissions = try JSONDecoder().decode(Permissions.self, from: Data(json.utf8))
        XCTAssertTrue(permissions.owner)
        XCTAssertTrue(permissions.allows(.contentWrite))
        XCTAssertFalse(permissions.allows(.policyEdit))
    }

    /// A server from before teams says only `role`.
    func testAServerBeforeTeamsSaysTheOwnerByRole() throws {
        let owner = try JSONDecoder().decode(Permissions.self, from: Data(#"{"role":"owner","granted":["bots.manage"]}"#.utf8))
        XCTAssertTrue(owner.owner)
        XCTAssertEqual(owner.teams, [])
        let admin = try JSONDecoder().decode(Permissions.self, from: Data(#"{"role":"admin","granted":["bots.manage"]}"#.utf8))
        XCTAssertFalse(admin.owner, "the old admin role is no owner")
        XCTAssertTrue(admin.allows(.botsManage))
    }

    func testTeamAndMemberEventsReadThePermissionsAgain() {
        for type in ["team.created", "team.updated", "team.removed", "member.updated", "member.removed", "role.updated"] {
            XCTAssertTrue(Permissions.refreshEvents.contains { type == $0 || ($0.hasSuffix(".") && type.hasPrefix($0)) }, type)
        }
    }

    func testAComputerGatesNothingAndACloudServerEverythingUntilRead() {
        XCTAssertTrue(RoleGate.open.allows(.contentWrite))
        XCTAssertTrue(RoleGate.open.allowsSending(toChiefOfStaff: true))
        XCTAssertFalse(RoleGate.cloud(nil).allows(.contentWrite), "permissions not read yet show nothing")
        XCTAssertFalse(RoleGate.cloud(nil).allowsSending(toChiefOfStaff: false))
    }

    func testOnlyBotsManageWritesToTheChiefOfStaff() {
        let viewer = RoleGate.cloud(Permissions(granted: []))
        let member = RoleGate.cloud(Permissions(teams: ["members"], granted: ["content.write", "projects.manage"]))
        let owner = RoleGate.cloud(Permissions(owner: true, teams: ["members", "owners"], granted: ["content.write", "projects.manage", "bots.manage"]))
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
        XCTAssertFalse(AgentClientError.status(403, code: "forbidden", message: "Only the owner can archive this task.").isForbidden, "a computer's own words stand")
        XCTAssertFalse(AgentClientError.status(404, code: "forbidden", message: nil).isForbidden)
    }
}
