import XCTest

/// Agent home's list under a finger: flicks up into its end and down into
/// its top, so it glides and bounces, while working statuses change ten
/// times a second. A separate case inserts/removes a subtask mid-bounce.
/// The same flicks run once with no updates, as the control.
///
/// The harness integrates the median screen movement of rows visible in
/// consecutive frames. Raw contentOffset can change to compensate for
/// rows inserted above without anything moving on screen. Compare visible
/// motion's velocity with its neighbours to detect abrupt corrections;
/// normalize by elapsed time to account for dropped simulator frames.
final class AgentListScrollUITests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false; _ = skipsQuiescence }

    private struct Frame {
        var time: Double
        var offset: Double
        var gliding: Bool
        var top: Double
        var bottom: Double
        var visibleMotion: Double
    }

    private func run(live: Bool, structural: Bool = false) throws -> (frames: [Frame], updates: Int) {
        let app = XCUIApplication()
        app.launchArguments = ["-screen", "agentList"] + (live ? ["-live"] : []) + (structural ? ["-structural"] : [])
        let name = structural ? "structural" : (live ? "status" : "still")
        app.launch()
        let list = app.scrollViews["agent-list"]
        XCTAssertTrue(list.waitForExistence(timeout: 20))
        sleep(1)
        for _ in 0..<2 {
            for _ in 0..<3 { list.swipeUp(velocity: .fast) }
            sleep(2)
            for _ in 0..<3 { list.swipeDown(velocity: .fast) }
            sleep(2)
        }
        let trace = app.otherElements["agent-list-trace"]
        let value = try XCTUnwrap(trace.value as? String)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(value.utf8)) as? [String: Any])
        let raw = try XCTUnwrap(object["frames"] as? [[Double]])
        let frames = raw.map { Frame(time: $0[0], offset: $0[1], gliding: Int($0[2]) & 4 != 0 && Int($0[2]) & 1 == 0, top: $0[3], bottom: $0[4], visibleMotion: $0[8]) }
        let updates = (object["updates"] as? Int) ?? 0
        let attachment = XCTAttachment(data: Data(value.utf8), uniformTypeIdentifier: "public.json")
        attachment.name = "agent-list-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let directory = ProcessInfo.processInfo.environment["HAPPY_PREVIEW_DIR"] {
            try? Data(value.utf8).write(to: URL(fileURLWithPath: directory).appendingPathComponent("agent-list-\(name).json"))
        }
        app.terminate()
        return (frames, updates)
    }

    /// The gliding frames whose speed is out of line with their
    /// neighbours' by more than `limit` points a second.
    private func jumps(_ name: String, _ frames: [Frame], limit: Double = 1500, nearBottom: Bool = false) -> Int {
        var speeds: [(time: Double, speed: Double, frame: Frame)] = []
        for (a, b) in zip(frames, frames.dropFirst()) where a.gliding && b.gliding && b.time > a.time {
            speeds.append((b.time, (b.visibleMotion - a.visibleMotion) / (b.time - a.time), b))
        }
        var count = 0
        var worst = 0.0
        for index in speeds.indices.dropFirst().dropLast() {
            let (previous, current, next) = (speeds[index - 1], speeds[index], speeds[index + 1])
            if nearBottom, [previous.frame, current.frame, next.frame].contains(where: { $0.offset < $0.bottom - 200 }) { continue }
            // Only frames that follow on: a gap is a new glide.
            guard current.time - previous.time < 0.05, next.time - current.time < 0.05 else { continue }
            let by = current.speed - (previous.speed + next.speed) / 2
            worst = max(worst, abs(by))
            if abs(by) > limit {
                count += 1
                let past = current.frame.offset - current.frame.bottom
                print("AGENT-LIST \(name) jump \(Int(by))pt/s at \(String(format: "%.3f", current.time)) offset \(Int(current.frame.offset)) past the end by \(Int(past))")
            }
        }
        let glide = frames.filter(\.gliding).count
        print("AGENT-LIST \(name): \(frames.count) frames, \(glide) gliding, \(count) out of line by over \(Int(limit))pt/s, worst \(Int(worst))pt/s")
        return count
    }

    func testStatusUpdatesDoNotInterruptTheGlide() throws {
        let still = try run(live: false)
        let live = try run(live: true)
        XCTAssertGreaterThan(live.updates, 50, "the computer sent too few updates to judge")
        XCTAssertGreaterThan(still.frames.filter(\.gliding).count, 60, "the list never glided")
        let control = jumps("no updates", still.frames)
        let measured = jumps("updates every 100ms", live.frames)
        print("AGENT-LIST \(live.updates) updates during the flicks")
        XCTAssertLessThanOrEqual(measured, control, "status updates moved the gliding list")
    }

    func testStructuralChangesDuringBounceKeepVisibleRowsSteady() throws {
        let still = try run(live: false)
        let live = try run(live: true, structural: true)
        XCTAssertGreaterThan(live.updates, 50)
        for run in [still, live] {
            XCTAssertGreaterThan(run.frames.filter { $0.gliding && $0.offset > $0.bottom - 200 }.count, 30, "the list never glided near its bottom")
            XCTAssertTrue(run.frames.contains { $0.offset > $0.bottom + 1 }, "the list never bounced beyond its bottom")
        }
        let control = jumps("no updates", still.frames, nearBottom: true)
        let measured = jumps("structural", live.frames, nearBottom: true)
        XCTAssertLessThanOrEqual(measured, control, "structural changes interrupted the bounce")
    }
}
