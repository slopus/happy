import Foundation
import XCTest
@testable import HappyCore

private actor RaceFixture {
    var sources: [AsyncThrowingStream<ServerSentEvent, Error>.Continuation] = []
    var cursors: [String?] = []
    var cancelled: Set<Int> = []
    var frames: [ServerSentEvent] = []

    func open(_ cursor: String?) -> AsyncThrowingStream<ServerSentEvent, Error> {
        let index = sources.count
        let (stream, source) = AsyncThrowingStream<ServerSentEvent, Error>.makeStream()
        source.onTermination = { [weak self] _ in Task { await self?.ended(index) } }
        sources.append(source); cursors.append(cursor)
        return stream
    }

    func ended(_ index: Int) { cancelled.insert(index) }
    func count() -> Int { sources.count }
    func cursor(_ index: Int) -> String? { cursors[index] }
    func stopped(_ index: Int) -> Bool { cancelled.contains(index) }
    func bothStopped() -> Bool { cancelled.contains(0) && cancelled.contains(1) }
    func heard() -> [String] { frames.compactMap(\.id) }
    func take(_ frame: ServerSentEvent) { frames.append(frame) }
    func emit(_ index: Int, id: String, data: String = "{}") {
        sources[index].yield(.init(id: id, event: "message", data: data))
    }
    func fail(_ index: Int) { sources[index].finish(throwing: URLError(.networkConnectionLost)) }
}

final class EventStreamRaceTests: XCTestCase {
    private struct Timeout: Error {}
    private func eventually(_ ready: @escaping () async -> Bool) async throws {
        for _ in 0..<1_000 {
            if await ready() { return }
            try await Task.sleep(for: .milliseconds(2))
        }
        XCTFail("event stream did not settle")
        throw Timeout()
    }

    private func reader(_ race: EventStreamRace, _ fixture: RaceFixture) -> Task<Void, Never> {
        Task { do { for try await frame in race.stream { await fixture.take(frame) } } catch {} }
    }

    func testHeldWinsAndLosingReaderCannotDeliver() async throws {
        let fixture = RaceFixture()
        let race = EventStreamRace { await fixture.open($0) }
        let reading = reader(race, fixture)
        await race.start(after: "before")
        try await eventually { await fixture.count() == 1 }
        await fixture.emit(0, id: "live")
        try await eventually { await fixture.heard() == ["live"] }
        await race.race(after: "live")
        try await eventually { await fixture.count() == 2 }
        await fixture.emit(0, id: "held")
        try await eventually { await fixture.stopped(1) }
        await fixture.emit(1, id: "loser")
        await fixture.emit(0, id: "next")
        try await eventually { await fixture.heard() == ["live", "held", "next"] }
        await race.close(); await reading.value
    }

    func testFreshWinsWhenHeldFlowIsDead() async throws {
        let fixture = RaceFixture()
        let race = EventStreamRace { await fixture.open($0) }
        let reading = reader(race, fixture)
        await race.start(after: "before")
        try await eventually { await fixture.count() == 1 }
        await race.race(after: "current")
        try await eventually { await fixture.count() == 2 }
        let cursor = await fixture.cursor(1)
        XCTAssertEqual(cursor, "current")
        await fixture.fail(0)
        await fixture.emit(1, id: "fresh")
        try await eventually { await fixture.heard() == ["fresh"] }
        await race.close(); await reading.value
    }

    func testMalformedFreshFrameCannotBeatHeldFlow() async throws {
        let fixture = RaceFixture()
        let race = EventStreamRace { await fixture.open($0) }
        let reading = reader(race, fixture)
        await race.start(after: nil)
        try await eventually { await fixture.count() == 1 }
        await race.race(after: "current")
        try await eventually { await fixture.count() == 2 }
        await fixture.emit(1, id: "bad", data: "not json")
        await fixture.emit(0, id: "held")
        try await eventually { await fixture.heard() == ["held"] }
        await race.close(); await reading.value
    }

    func testSilentRaceClosesBothAndEndsTheStream() async throws {
        let fixture = RaceFixture()
        let race = EventStreamRace(limit: .milliseconds(50)) { await fixture.open($0) }
        let reading = Task { () -> Bool in
            do { for try await _ in race.stream {}; return false } catch { return true }
        }
        await race.start(after: nil)
        try await eventually { await fixture.count() == 1 }
        await race.race(after: "current")
        try await eventually { await fixture.count() == 2 }
        await fixture.fail(1)
        let failed = await reading.value
        XCTAssertTrue(failed, "the stream ends as one gone silent")
        try await eventually { await fixture.bothStopped() }
    }

    func testClosingRaceClosesBothCandidates() async throws {
        let fixture = RaceFixture()
        let race = EventStreamRace { await fixture.open($0) }
        await race.start(after: nil)
        try await eventually { await fixture.count() == 1 }
        await race.race(after: "current")
        try await eventually { await fixture.count() == 2 }
        await race.close()
        try await eventually { await fixture.bothStopped() }
    }
}
