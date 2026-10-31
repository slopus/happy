import Foundation
import XCTest
@testable import HappyCore
@testable import HappyStore
import HappyWire

/// A legacy session's profile's head: the avatar home's row draws (one
/// seed, so one placeholder), its status; a change to them retexts the head
/// and makes no group again.
final class ProfileHeadTests: XCTestCase {
    typealias Fixture = TabletGroupedListTests

    private static let record = Fixture.session("s1", machine: "m1", path: "/work/happy", title: "Primary")

    private func detail(_ record: SessionRecord) -> SessionDetailSnapshot {
        SessionDetailSnapshot(session: record, machine: Fixture.machine("m1", active: true, name: "Studio"),
                              settings: SettingsSnapshot(), dataReady: true, composer: .object([:]))
    }

    func testTheProfilesAvatarIsHomesRowsAvatar() throws {
        let model = try XCTUnwrap(SessionInfoFrame(SessionInfoInput(), detail: detail(Self.record)).model)
        XCTAssertEqual(model.avatar.seed, Self.record.avatarSeed)
        XCTAssertEqual(model.avatar.seed, "m1:/work/happy")
        // Home's row, as home works it out from the same record.
        let list = SessionList(LegacyHomeSnapshot(machines: MachinesSnapshot(synced: true, machines: []), sessions: [Self.record]))
        let homeSeed = list.items.compactMap { item -> String? in
            if case .session(let row) = item { return row.avatar.seed }
            return nil
        }.first
        XCTAssertEqual(homeSeed, model.avatar.seed)
    }

    func testAStatusChangeRetextsOnlyTheHead() throws {
        var input = SessionInfoInput()
        input.detail = detail(Self.record)
        let first = try XCTUnwrap(SessionInfoDerivation.derive(input, applied: nil))
        var thinking = Self.record
        thinking.thinking = true
        thinking.thinkingAt = Self.record.updatedAt
        input.detail = detail(thinking)
        let next = try XCTUnwrap(SessionInfoDerivation.derive(input, applied: first.state))
        XCTAssertTrue(next.output.changes.header)
        XCTAssertFalse(next.output.changes.title)
        XCTAssertEqual(next.output.changes.rebuilt, [.activity], "only Activity says whether it thinks")
        XCTAssertEqual(next.output.frame.model?.status.tone, .thinking)
    }
}
