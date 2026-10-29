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
        app.launchEnvironment["STEM_GYM_SCRIPT"] = "dragdown top wait*8"
        launch()
        for title in [chat, environment["GYM_IMAGES"] ?? "Gym Pictures"] {
            open(title)
            // Up to the top until the rows stop growing four times running:
            // the first message is in. Each time at the top asks for the page
            // before, and a page over a slow connection takes seconds. Down a
            // little first: a page landing at the very top leaves nothing to
            // scroll, and only a scroll asks for the next.
            var rows = -1
            var still = 0
            for _ in 0..<200 where still < 4 {
                runScript("dragdown top wait*8")
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

    /// The sidebar itself: flung down its rows and back, then each heading
    /// folded and unfolded, so the rows after it move up and back.
    func testSidebar() {
        launch()
        pause(3)
        resetMeter()
        for _ in 0..<2 {
            fling(down: false)
            fling(down: true)
        }
        let headings = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "stem-row:section:"))
        XCTAssertTrue(headings.firstMatch.waitForExistence(timeout: 5), "no section headings")
        for index in (0..<min(2, headings.count)).reversed() {
            let heading = headings.element(boundBy: index)
            // The heading's title, clear of its "+".
            let title = heading.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5))
            title.tap()
            pause(1.5)
            title.tap()
            pause(1.5)
        }
        report("sidebar")
    }

    /// Not a workload: a story posted live (`gym.py` posts it on
    /// `GYM_POST_STORY`, an html artifact as its one frame, as SHIP BOSS's
    /// was) puts a ring on its task's row, and a tap on that ring opens it
    /// in the viewer, not the chat, with no relaunch; once it has played
    /// the ring is seen. Posted twice: with home on screen, and with the
    /// task's chat on screen, home only come back to after.
    func testStoryRingOpens() {
        let task = environment["GYM_STORY_TASK"] ?? "Release notes"
        launch()
        var row = find(task)
        pause(2)
        print("GYM_POST_STORY \(task)")
        watchRing(row, "posted on home")

        // As SHIP BOSS had it: in the chat, + and its permission changed
        // first, then the story posted while the chat is on screen.
        open(task)
        app.buttons["Add a picture"].tap()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if springboard.alerts.firstMatch.waitForExistence(timeout: 3) {
            springboard.alerts.firstMatch.buttons["Don’t Allow"].tap()
        }
        let permission = app.descendants(matching: .any)["attach-permission"]
        XCTAssertTrue(permission.waitForExistence(timeout: 5), "+ didn't open its sheet")
        pause(1)
        permission.tap()
        let auto = app.collectionViews.buttons.matching(NSPredicate(format: "label == 'Auto' OR label BEGINSWITH 'Auto,'")).firstMatch
        XCTAssertTrue(auto.waitForExistence(timeout: 5), "no permission menu")
        auto.tap()
        pause(1)
        app.buttons["attach-close"].tap()
        pause(1)
        print("GYM_POST_STORY \(task)")
        pause(8)
        app.buttons["stem-chat-back"].firstMatch.tap()
        row = find(task)
        watchRing(row, "posted in its chat")
    }

    /// Not a workload: with the photo library never asked about, the composer's + opens its sheet and Photos opens the
    /// system's picker without either asking for the library; a photo
    /// picked there waits in the composer.
    func testAttachAsksNothing() {
        app.resetAuthorizationStatus(for: .photos)
        launch()
        open(environment["GYM_STORY_TASK"] ?? "Release notes")
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        app.buttons["Add a picture"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["attach-sheet"].waitForExistence(timeout: 5), "+ didn't open its sheet")
        XCTAssertFalse(springboard.alerts.firstMatch.waitForExistence(timeout: 3), "+ asked for the photo library")
        app.buttons["attach-photos"].tap()
        XCTAssertFalse(springboard.alerts.firstMatch.waitForExistence(timeout: 3), "Photos asked for the photo library")
        XCTAssertFalse(app.descendants(matching: .any)["library-picker"].exists, "Photos opened the app's own library, which needs it")
        let photo = app.images.matching(NSPredicate(format: "label BEGINSWITH 'Photo'")).firstMatch
        XCTAssertTrue(photo.waitForExistence(timeout: 10), "the system's picker shows no photo")
        pause(1.5)
        // The picker runs in its own process: its photos are found, not hittable.
        photo.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        let add = app.buttons.matching(NSPredicate(format: "label == 'Add' OR identifier == 'Add'")).firstMatch
        if add.waitForExistence(timeout: 3) { add.tap() }
        let attached = app.descendants(matching: .any).matching(identifier: "composer-attachment").firstMatch
        XCTAssertTrue(attached.waitForExistence(timeout: 10), "the picked photo didn't attach")
        pause(2)
    }

    /// Not a workload: a fresh install over a computer the last install
    /// paired, that no longer answers. The driver pairs, deletes the app
    /// (the Keychain keeps the pairing), stops the daemon and installs the
    /// app again. As SHIP BOSS had it: Relay and Direct off, as on any fresh
    /// install, then Direct chosen and its button tapped. It stays on
    /// linking a computer, not that computer's home or a chat on it.
    func testLeftoverComputerLinks() {
        app.launchEnvironment.removeValue(forKey: "STEM_DIRECT")
        app.launchArguments = []
        app.launch()
        let link = app.descendants(matching: .any)["stem-link"]
        XCTAssertTrue(link.waitForExistence(timeout: 15), "a fresh install didn't open on linking a computer")
        app.segmentedControls["stem-link-method"].buttons.matching(NSPredicate(format: "label BEGINSWITH 'Direct'")).firstMatch.tap()
        let scan = app.buttons["Scan QR code"]
        XCTAssertTrue(scan.waitForExistence(timeout: 5), "Direct didn't show its way to link")
        pause(2)
        let rows = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "stem-row:"))
        XCTAssertTrue(link.exists, "choosing Direct left linking")
        XCTAssertFalse(app.descendants(matching: .any)["stem-new-work"].exists || rows.firstMatch.exists, "choosing Direct opened the last install's computer")
        scan.tap()
        pause(2)
        XCTAssertFalse(app.descendants(matching: .any)["stem-new-work"].exists, "Scan opened the last install's computer")
        XCTAssertFalse(app.scrollViews["stem-transcript"].exists, "Scan opened a chat")
    }

    /// The ring on `row` turns new, opens its viewer at a tap, and is seen once closed.
    private func watchRing(_ row: XCUIElement, _ when: String) {
        XCTAssertTrue(until(40) { (row.value as? String)?.contains("new stor") == true }, "\(when): no new story came to the ring: \(row.value ?? "")")
        pause(1)
        // The ring's middle: the disc 7 into the card, which is 3 in, 50 across.
        row.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 7 + 29, dy: row.frame.height / 2)).tap()
        let viewer = app.descendants(matching: .any)["story-viewer-page"]
        XCTAssertTrue(viewer.waitForExistence(timeout: 10), "\(when): a tap on the ring opened no viewer")
        XCTAssertFalse(app.scrollViews["stem-transcript"].exists, "\(when): the ring opened the chat")
        pause(2)
        app.descendants(matching: .any)["story-close"].firstMatch.tap()
        XCTAssertTrue(until(10) { !viewer.exists }, "\(when): the viewer never closed")
        XCTAssertTrue(until(10) { (row.value as? String)?.contains("new stor") == false }, "\(when): the ring stayed unseen: \(row.value ?? "")")
    }

    private func until(_ seconds: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if condition() { return true }
            pause(0.3)
        }
        return condition()
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
