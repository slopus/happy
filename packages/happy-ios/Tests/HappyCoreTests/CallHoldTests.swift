import Foundation
@testable import HappyCore
import XCTest

/// A call behaves as a phone call while the phone has the audio (another
/// call, Siri, an alarm): it is held, not ended, its silence isn't
/// counted, and a connection lost meanwhile is made again when the hold
/// ends, the call carried over (docs/agent-voice-call.md, "Behave like a
/// phone call").
@MainActor
final class CallHoldTests: XCTestCase {
    private var connects = 0
    private var connections: [FakeCallConnection] = []
    private var events: CallEvents?
    private var clock = 1000.0

    private func call(timing: CallCues.Timing = CallCues.Timing(), history: CallHistory? = nil) -> CallSession {
        CallSession(grants: FakeGrants(.granted(CallGrant(agentId: "g"))), permission: { true }, history: history,
                    timing: timing, tick: .milliseconds(20), now: { [unowned self] in clock }) { [unowned self] _, _, callEvents in
            connects += 1
            events = callEvents
            let connection = FakeCallConnection()
            connections.append(connection)
            return connection
        }
    }

    private func live(_ session: CallSession) async {
        await waitUntil { if case .active = session.state { true } else { false } }
    }

    private func waitUntil(_ condition: () -> Bool) async {
        for _ in 0..<500 where !condition() { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(condition())
    }

    func testAConnectionLostOnHoldIsMadeAgainWhenTheHoldEnds() async {
        let history = CallHistory(store: nil)
        let session = call(history: history)
        var ended: [CallEnding] = []
        session.onEnded = { ended.append($0) }
        session.start(language: nil, context: { "" }, tool: { _ in CallToolResult(text: "") })
        await live(session)
        events?.heard("Hold on.")
        session.hold()
        XCTAssertTrue(session.isHeld)
        let held = events
        held?.disconnected()
        // Not ended: waiting for the audio, with nothing connecting yet.
        XCTAssertEqual(session.state, .connecting)
        XCTAssertEqual(connects, 1)
        await waitUntil { ended == [.interrupted] }
        XCTAssertFalse(ended[0].isUnexpected, "no drop sound")
        session.resume()
        await live(session)
        XCTAssertEqual(connects, 2)
        XCTAssertFalse(session.isHeld)
        // The new call's recap says how the last one was cut off.
        XCTAssertEqual(history.slots.map(\.kind), [.person, .ended])
        XCTAssertEqual(history.slots.last?.ending, .interrupted)
        // What the old connection still says changes nothing.
        held?.disconnected()
        XCTAssertNotEqual(session.state, .ended(.connection))
        session.stop()
    }

    func testAHeldCallKeepsItsConnectionAndCarriesOn() async {
        let session = call()
        session.start(language: nil, context: { "" }, tool: { _ in CallToolResult(text: "") })
        await live(session)
        session.hold()
        session.resume()
        XCTAssertEqual(connects, 1)
        XCTAssertEqual(session.state, .active(.listening, muted: false, since: 1000))
        session.stop()
        XCTAssertEqual(session.state, .idle)
    }

    func testSilenceOnHoldIsNotCounted() async {
        var timing = CallCues.Timing()
        timing.silenceWarning = 5
        timing.silenceEnd = 10
        let session = call(timing: timing)
        session.start(language: nil, context: { "" }, tool: { _ in CallToolResult(text: "") })
        await live(session)
        session.hold()
        clock += 60
        try? await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(session.state, .active(.listening, muted: false, since: 1000))
        XCTAssertEqual(connections.last?.cues, [])
        // From the end of the hold the silence counts again.
        session.resume()
        try? await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(connections.last?.cues, [])
        clock += 6
        await waitUntil { connections.last?.cues.count == 1 }
        clock += 6
        await waitUntil { session.state == .idle }
    }

    /// The app was suspended on hold and only learns its connection went
    /// once the audio is back: that is the hold's too. Long after, a drop is a drop.
    func testADropJustAfterTheHoldIsTheHolds() async {
        let session = call()
        session.start(language: nil, context: { "" }, tool: { _ in CallToolResult(text: "") })
        await live(session)
        session.hold()
        session.resume()
        clock += CallSession.holdGrace - 1
        events?.disconnected()
        await live(session)
        XCTAssertEqual(connects, 2)
        clock += CallSession.holdGrace + 1
        events?.disconnected()
        XCTAssertEqual(session.state, .ended(.connection))
        XCTAssertEqual(connects, 2)
    }

    /// The media services were reset, or the engine didn't come back: a
    /// new connection at once, the call carried over.
    func testReconnectMakesANewConnectionAtOnce() async {
        let session = call()
        session.start(language: nil, context: { "" }, tool: { _ in CallToolResult(text: "") })
        await live(session)
        session.reconnect()
        XCTAssertEqual(session.state, .connecting)
        await live(session)
        XCTAssertEqual(connects, 2)
        await waitUntil { connections.first?.ended == true }
        session.stop()
    }

    func testHangingUpOnHoldEndsPlainly() async {
        let session = call()
        var ended: [CallEnding] = []
        session.onEnded = { ended.append($0) }
        session.start(language: nil, context: { "" }, tool: { _ in CallToolResult(text: "") })
        await live(session)
        session.hold()
        session.stop()
        XCTAssertEqual(session.state, .idle)
        XCTAssertFalse(session.isHeld)
        await waitUntil { ended == [.hungUp] }
        // Nothing to resume.
        session.resume()
        XCTAssertEqual(session.state, .idle)
        XCTAssertEqual(connects, 1)
    }
}
