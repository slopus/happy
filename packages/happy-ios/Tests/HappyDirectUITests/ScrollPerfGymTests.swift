import Darwin
import ObjectiveC
import XCTest

/// The transcript and the working line never idle for XCUITest's wait
/// around every action; as StemCellsUITests does, the private wait goes.
private let skipsQuiescence: Bool = {
    guard let process = NSClassFromString("XCUIApplicationProcess") else { return false }
    var replaced = false
    let one: @convention(block) (AnyObject, Bool) -> Void = { _, _ in }
    let two: @convention(block) (AnyObject, Bool, Bool) -> Void = { _, _, _ in }
    for (name, block) in [
        ("waitForQuiescenceIncludingAnimationsIdle:", one as Any),
        ("waitForQuiescenceIncludingAnimationsIdle:isPreEvent:", two as Any),
    ] {
        guard let method = class_getInstanceMethod(process, NSSelectorFromString(name)) else { continue }
        method_setImplementation(method, imp_implementationWithBlock(block))
        replaced = true
    }
    return replaced
}()

/// The iOS performance gym (`docs/PERF-GYM.md`): scripted workloads on a
/// long Stem Cells conversation against a throwaway Happy Agent, each
/// measured by the app's own frame meter (`GymFrameMeter`: frame intervals,
/// dropped frames, hitch time, main-thread time per frame, memory) and by
/// XCTest's hitch metrics. Each prints `GYM_RESULT <workload> <pairs>`,
/// which `scripts/perf-gym/run.py` checks against `budgets.json`.
///
/// `GYM_CHAT` names the conversation's row (its title), `GYM_IMAGES` the
/// one heavy with pictures, `GYM_STREAM` the one a reply streams into
/// (`fakellm.py`'s "stream P W"). `GYM_ITERATIONS` repeats the XCTest
/// metrics (default 3).
@MainActor
final class ScrollPerfGymTests: XCTestCase {
    private let app = XCUIApplication()
    private var environment: [String: String] { ProcessInfo.processInfo.environment }
    private var chat: String { environment["GYM_CHAT"] ?? "Gym Long Chat" }
    private var iterations: Int { Int(environment["GYM_ITERATIONS"] ?? "") ?? 3 }

    override func setUp() {
        continueAfterFailure = false
        print("ScrollPerfGymTests skips quiescence: \(skipsQuiescence)")
        app.launchEnvironment["STEM_DIRECT"] = "1"
        app.launchEnvironment["STEM_GYM_METER"] = "1"
        app.launchArguments += ["-stemCells.direct", "YES"]
    }

    // MARK: Workloads

    /// Not a workload: reads the gym's conversations back to their first
    /// message, as someone who has read their long chats has them, so every
    /// workload after it starts from the whole history on the phone.
    func testPrime() {
        app.launchEnvironment["STEM_GYM_SCRIPT"] = "top wait*6"
        launch()
        for title in [chat, environment["GYM_IMAGES"] ?? "Gym Pictures"] {
            open(title)
            // Up to the top until the rows stop growing twice: the first
            // message is in. Each time at the top asks for the page before.
            var rows = -1
            var still = 0
            for _ in 0..<200 where still < 2 {
                runScript("top wait*6")
                let now = reading("rows")
                still = now == rows ? still + 1 : 0
                rows = now
            }
            print("GYM_PRIME \(title) rows=\(rows)")
            app.buttons["stem-chat-back"].firstMatch.tap()
            pause(2)
        }
    }

    /// Opening the long chat from the sidebar for the first time after a
    /// launch: how long until the transcript shows, and the frames of the push.
    func testOpenCold() {
        launch()
        let row = find(chat)
        resetMeter()
        row.tap()
        let timing = waitForTranscript()
        pause(2)
        report("open-cold", extra: timing)
    }

    /// Back to the sidebar and in again: the chat read ahead (warm).
    func testOpenWarm() {
        launch()
        open(chat)
        pause(3)
        app.buttons["stem-chat-back"].firstMatch.tap()
        pause(2)
        let row = find(chat)
        resetMeter()
        row.tap()
        let timing = waitForTranscript()
        pause(2)
        report("open-warm", extra: timing)
    }

    /// Fast flings from the newest message back towards the top.
    func testFlingToTop() {
        scripted("fling-to-top", chat, "up*12")
        measureHitches("fling-to-top") { self.fling(down: true); self.fling(down: true) }
    }

    /// Far back first, then fast flings back down to the newest message.
    func testFlingToBottom() {
        scripted("fling-to-bottom", chat, "up*12 wait down*12", before: "up*12")
        measureHitches("fling-to-bottom") { self.fling(down: true); self.fling(down: false) }
    }

    /// Slow drags, a finger reading line by line, back into history and down again.
    func testSlowDrag() {
        scripted("slow-drag", chat, "dragup*12 dragdown*4 dragup*4", before: "up*2")
        measureDragging("slow-drag") { self.drag(down: true); self.drag(down: false) }
    }

    /// The conversation heaviest with pictures, flung through.
    func testImageHeavy() {
        scripted("image-heavy", environment["GYM_IMAGES"] ?? "Gym Pictures", "up*8 down*8")
        measureHitches("image-heavy") { self.fling(down: true); self.fling(down: false) }
    }

    /// A long chat whose history is not on the phone yet (`GYM_PAGING`; the
    /// runner forgets what the phone kept of it first), flung back into it:
    /// every page that lands is laid out while the reader moves. A fling
    /// goes about 2,500 pt, short of a page's top: `top` runs there.
    func testHistoryPaging() {
        scripted("history-paging", environment["GYM_PAGING"] ?? chat, "top up*2 down*2 top up*2 down*2 top up*2 down*2")
    }

    /// A reply streaming into the long chat while the reader flings and
    /// drags up into history and back down.
    func testScrollWhileStreaming() {
        app.launchEnvironment["STEM_GYM_SCRIPT"] = "up dragdown up dragdown up dragdown down*4"
        launch()
        open(environment["GYM_STREAM"] ?? chat)
        let composer = app.textViews["stem-composer"]
        composer.tap()
        composer.typeText("stream 30 40 \(Int(Date().timeIntervalSince1970) % 100_000)")
        app.buttons["Send"].tap()
        let working = app.descendants(matching: .any)["stem-working"]
        XCTAssertTrue(working.waitForExistence(timeout: 20), "the reply never started")
        pause(3)
        dismissKeyboard()
        runScript("up dragdown up dragdown up dragdown down*4")
        report("scroll-while-streaming", extra: working.exists ? "streaming=1" : "streaming=0")
        let deadline = Date().addingTimeInterval(120)
        while Date() < deadline, working.exists { pause(1) }
    }

    /// Opens `title`, plays `before` unmeasured, then `script` measured
    /// (`GymFrameMeter`'s scripted scroll), and reports it as `workload`.
    private func scripted(_ workload: String, _ title: String, _ script: String, before: String? = nil) {
        let whole = before.map { "\($0) wait mark \(script)" } ?? script
        app.launchEnvironment["STEM_GYM_SCRIPT"] = whole
        launch()
        open(title)
        runScript(whole)
        report(workload)
    }

    /// Taps the meter's run button, which resets it and plays `script`
    /// (set at launch as `STEM_GYM_SCRIPT`), and waits it out without
    /// reading the screen meanwhile.
    private func runScript(_ script: String) {
        let seconds = script.split(separator: " ").reduce(0.0) { total, token in
            let parts = token.split(separator: "*")
            let count = Double(parts.count > 1 ? Int(parts[1]) ?? 1 : 1)
            let each: Double = parts[0].hasPrefix("drag") ? 1.3 : parts[0] == "wait" ? 0.5 : parts[0] == "mark" ? 0 : 3.1
            return total + count * each
        }
        // Told by a Darwin notification, which reaches the app in the same
        // simulator: a tap would read the screen first.
        post("com.slopus.happy.gym.run")
        print("GYM_MARK start")
        pause(seconds + 1.5)
        // Late frames stretch it out: looked at now and then, as each look
        // holds the app's main thread.
        let deadline = Date().addingTimeInterval(90)
        while reading("scripting") != 0, Date() < deadline { pause(5) }
        XCTAssertEqual(reading("scripting"), 0, "the script was still running")
    }

    // MARK: Driving

    private func launch() {
        app.launch()
        let any = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "stem-row:")).firstMatch
        if any.waitForExistence(timeout: 10) { return }
        print("STEM_PAIR_READY")
        let match = app.buttons["Emoji match"]
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let deadline = Date().addingTimeInterval(120)
        while Date() < deadline, !match.exists {
            for alert in [app.alerts.firstMatch, springboard.alerts.firstMatch] where alert.buttons["Open"].exists {
                alert.buttons["Open"].tap()
            }
            _ = match.waitForExistence(timeout: 1)
        }
        XCTAssertTrue(match.exists, "pairing never showed its emoji")
        pause(1.5)
        match.tap()
        XCTAssertTrue(any.waitForExistence(timeout: 90))
    }

    /// The row titled `title`, brought on screen.
    private func find(_ title: String) -> XCUIElement {
        let row = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND identifier ENDSWITH %@", "stem-row:", ":\(title)")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15), "no row \(title)")
        let height = app.frame.height
        for _ in 0..<20 where !(row.frame.midY > height * 0.15 && row.frame.midY < height * 0.75) {
            let up = row.frame.midY > height * 0.5
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: up ? 0.7 : 0.3)).press(
                forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: up ? 0.4 : 0.6)),
                withVelocity: .slow, thenHoldForDuration: 0.3
            )
            pause(0.6)
        }
        return row
    }

    private func open(_ title: String) {
        find(title).tap()
        _ = waitForTranscript()
        // History read, pictures in.
        pause(4)
    }

    /// The transcript's value once it is up: the open's timing.
    @discardableResult
    private func waitForTranscript() -> String {
        let transcript = app.scrollViews["stem-transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 30), "the transcript never showed")
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline, !((transcript.value as? String) ?? "").hasPrefix("first=") { pause(0.2) }
        return (transcript.value as? String ?? "").replacingOccurrences(of: " ", with: ",")
    }

    /// A fast fling over the transcript; `down` moves the content down, back into history.
    private func fling(down: Bool) {
        let top = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25))
        let bottom = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.72))
        (down ? top : bottom).press(forDuration: 0.01, thenDragTo: down ? bottom : top, withVelocity: .fast, thenHoldForDuration: 0)
        // Until the glide is over: the next gesture reads the screen first,
        // which holds the app's main thread, and must not land mid-glide.
        pause(3.5)
    }

    /// A slow drag of about a third of the screen, held at its end so nothing flings.
    private func drag(down: Bool) {
        let top = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
        let bottom = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.65))
        (down ? top : bottom).press(forDuration: 0.05, thenDragTo: down ? bottom : top, withVelocity: 260, thenHoldForDuration: 0.2)
        pause(0.4)
    }

    private func dismissKeyboard() {
        guard app.keyboards.firstMatch.exists else { return }
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).press(
            forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)), withVelocity: .slow, thenHoldForDuration: 0.2
        )
        pause(1)
    }

    private func post(_ name: String) {
        CFNotificationCenterPostNotification(CFNotificationCenterGetDarwinNotifyCenter(), CFNotificationName(name as CFString), nil, nil, true)
    }

    private func pause(_ seconds: TimeInterval) { Thread.sleep(forTimeInterval: seconds) }

    // MARK: Measuring

    private var meter: XCUIElement { app.buttons["stem-gym-meter"] }

    /// One integer of the meter's reading.
    private func reading(_ key: String) -> Int {
        let value = (meter.value as? String) ?? ""
        let pair = value.split(separator: " ").first { $0.hasPrefix("\(key)=") }
        return pair.flatMap { Int($0.dropFirst(key.count + 1)) } ?? -1
    }

    private func resetMeter() {
        XCTAssertTrue(meter.waitForExistence(timeout: 5), "no gym meter: is STEM_GYM_METER read by this build?")
        post("com.slopus.happy.gym.reset")
        print("GYM_MARK start")
        pause(0.5)
    }

    /// The meter's reading since the last reset, printed for the runner and kept.
    private func report(_ workload: String, extra: String? = nil) {
        let value = (meter.value as? String) ?? ""
        let line = "GYM_RESULT \(workload) \(value)" + (extra.map { " \($0)" } ?? "")
        print(line)
        let attachment = XCTAttachment(string: line)
        attachment.name = "gym-\(workload)"
        attachment.lifetime = .keepAlways
        add(attachment)
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "gym-\(workload)"
        shot.lifetime = .keepAlways
        add(shot)
    }

    /// XCTest's own hitch metrics over `block`, a fling each way.
    private func measureHitches(_ workload: String, _ block: @escaping () -> Void) {
        let options = XCTMeasureOptions()
        options.iterationCount = iterations
        measure(metrics: [XCTOSSignpostMetric.scrollDecelerationMetric, XCTHitchMetric(application: app)], options: options, block: block)
    }

    private func measureDragging(_ workload: String, _ block: @escaping () -> Void) {
        let options = XCTMeasureOptions()
        options.iterationCount = iterations
        measure(metrics: [XCTOSSignpostMetric.scrollDraggingMetric, XCTHitchMetric(application: app)], options: options, block: block)
    }
}
