import XCTest

/// Device QA for the UltraList chat (`HappyChatHarness -chatUltraList
/// -qaProbe`): each test drives fixture chats with synthesized touches,
/// takes screenshots, and attaches the probe's action windows per step
/// (`ChatUltraQAProbe`): frame gaps, not-ready rows and drift. Fixture
/// feed, offline: sends, permissions and answers go to
/// `FixtureChatControls`, never to a server.
///
/// Nothing reads the app while it moves: every accessibility read makes the
/// app serialize its tree on the main thread (125–200 ms on an iPhone 12),
/// which would show up as the scroller's missed frames. Gestures are aimed
/// through SpringBoard's coordinate space, so aiming them doesn't read the
/// app either (the test falls back to the app's own space if a touch
/// doesn't arrive). A step acts, waits a fixed time without reading, and
/// only then reads the windows it produced.
///
/// System alerts are never answered: one fails and stops the test.
///
/// A feature a fixture is built to show must be found and acted on, or the
/// test fails; one a clip can't reach offline is recorded as not covered,
/// with the reason. Each test attaches its coverage.
///
/// `QA_PASS` (from `TEST_RUNNER_QA_PASS`) prefixes the probe's file names,
/// so a recorded pass and an unrecorded timing pass keep separate files.
///
/// The class is main-actor isolated, as XCUIAutomation is. XCTest's own
/// setUp and tearDown are nonisolated, so each test calls `prepare()` and
/// defers `finish()` instead.
@MainActor
final class ChatUltraQATests: XCTestCase {
    private var app: XCUIApplication!
    private var springboard: XCUIApplication { XCUIApplication(bundleIdentifier: "com.apple.springboard") }
    private var steps: [[String: Any]] = []
    private var clip = ""
    private var size = CGSize(width: 390, height: 844)
    /// Windows already attributed to a step in the current launch.
    private var known = 0
    private var touchedLast = false
    private var flungLast = false
    private var coverage: [[String: String]] = []
    private static var aimThroughSpringboard = true

    /// The start of every test.
    private func prepare() {
        continueAfterFailure = true
        _ = skipsQuiescence
        // Ahead of XCTest's own handler, which would tap a default button.
        _ = addUIInterruptionMonitor(withDescription: "Fail on any system alert") { [weak self] alert in
            self?.continueAfterFailure = false
            XCTFail("A system alert appeared and was left unanswered: \(alert.label)")
            return true
        }
    }

    /// Deferred by every test.
    private func finish() {
        flushSteps()
        if !coverage.isEmpty, let data = try? JSONSerialization.data(withJSONObject: coverage, options: [.prettyPrinted, .sortedKeys]) {
            attach("\(name) coverage", String(decoding: data, as: UTF8.self))
        }
        XCUIDevice.shared.orientation = .portrait
    }

    private func flushSteps() {
        guard !steps.isEmpty, let data = try? JSONSerialization.data(withJSONObject: steps, options: [.prettyPrinted, .sortedKeys]) else { return }
        attach("\(clip) steps", String(decoding: data, as: UTF8.self))
        steps = []
    }

    // MARK: Launching

    private var pass: String { ProcessInfo.processInfo.environment["QA_PASS"] ?? "pass" }

    private func launchChat(_ fixture: String, clip: String, ultra: Bool = true, extra: [String] = []) {
        let app = XCUIApplication()
        app.launchArguments = ["-fixture", fixture, "-qaProbe", "-qaRun", "\(pass)-\(clip)"] + (ultra ? ["-chatUltraList"] : []) + extra
        launch(app, clip: clip)
    }

    private func launchHome(clip: String, renderer: String = "UITableView", grouping: String = "flat", ultra: Bool = true) {
        let app = XCUIApplication()
        app.launchArguments = ["-screen", "home", "-renderer", renderer, "-grouping", grouping, "-sessionCount", "0", "-archiveCount", "0",
                               "-qaProbe", "-qaRun", "\(pass)-\(clip)"] + (ultra ? ["-chatUltraList"] : [])
        launch(app, clip: clip)
    }

    private func launch(_ app: XCUIApplication, clip: String) {
        flushSteps()
        self.clip = clip
        known = 0
        app.launch()
        self.app = app
        let alerts = springboard.alerts
        if alerts.count > 0 {
            continueAfterFailure = false
            XCTFail("A system alert is up: \(alerts.firstMatch.label). Stopping without answering it.")
        }
    }

    // MARK: Reading the probe (only at rest)

    private func read(_ name: String) -> [String: Any] {
        let element = app.otherElements[name]
        guard element.exists, let value = element.value as? String,
              let object = try? JSONSerialization.jsonObject(with: Data(value.utf8)) as? [String: Any] else { return [:] }
        return object
    }

    private func state() -> [String: Any] { read("chat-ultra-qa")["state"] as? [String: Any] ?? [:] }
    private func windows() -> [[String: Any]] { read("chat-ultra-qa")["windows"] as? [[String: Any]] ?? [] }
    private func controls() -> [String: Any] { read("chat-ultra-qa-controls") }

    private func scrollProbe() -> [String: Any] { read("chat-scroll-probe") }

    private func int(_ value: Any?) -> Int { (value as? NSNumber)?.intValue ?? 0 }
    private func number(_ value: Any?) -> CGFloat { CGFloat((value as? NSNumber)?.doubleValue ?? .nan) }

    private func rect(_ value: Any?) -> CGRect? {
        guard let values = value as? [NSNumber], values.count == 4 else { return nil }
        return CGRect(x: values[0].doubleValue, y: values[1].doubleValue, width: values[2].doubleValue, height: values[3].doubleValue)
    }

    private func wait(_ timeout: TimeInterval, every interval: TimeInterval = 0.5, until condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > deadline { return false }
            Thread.sleep(forTimeInterval: interval)
        }
        return true
    }

    /// The gate every clip starts with: the expected renderer, its list
    /// mounted, no collection view in an UltraList chat, rows drawn. The
    /// windows so far (opening, first applies) are recorded as "ready".
    private func assertReady(_ label: String, ultra: Bool = true, timeout: TimeInterval = 30) {
        let ready = wait(timeout) {
            let s = state()
            return (s["listInWindow"] as? Bool) == true && (s["displayReady"] as? Bool) == true && int(s["rows"]) > 0
        }
        let s = state()
        attach("\(clip) \(label) state", "\(s)")
        XCTAssertTrue(ready, "\(clip) \(label): rows never drew")
        if !ready, let data = try? JSONSerialization.data(withJSONObject: s["ultraNotReady"] ?? [:], options: [.prettyPrinted, .sortedKeys]) {
            attach("\(clip) \(label) UltraList not drawn", String(decoding: data, as: UTF8.self))
        }
        if ultra {
            XCTAssertEqual(s["renderer"] as? String, "UltraList", label)
            XCTAssertEqual(s["ultraMounted"] as? Bool, true, label)
            XCTAssertEqual(int(s["collectionViews"]), 0, label)
        } else {
            XCTAssertEqual(s["renderer"] as? String, "UICollectionView", label)
        }
        let frame = app.windows.firstMatch.frame
        if frame.width > 0 { size = frame.size }
        let all = windows()
        steps.append(["step": "\(label) ready", "windows": all.dropFirst(known).map(compact)])
        known = all.count
    }

    // MARK: Evidence

    private func attach(_ name: String, _ text: String) {
        let attachment = XCTAttachment(string: text)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        print("ChatUltraQA \(name): \(text.prefix(3000))")
    }

    private func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "\(clip)-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        mark("shot \(name)")
    }

    /// Wall-clock marks, to place events in the test's screen recording.
    private func mark(_ event: String) {
        attach("mark \(clip) \(event)", "{\"event\":\"\(event)\",\"wall\":\(Date().timeIntervalSince1970)}")
    }

    private static let windowKeys: Set<String> = [
        "seconds", "frames", "gapP50Ms", "gapP95Ms", "gapP99Ms", "gapMaxMs", "missedFrames", "hitches", "turnMaxMs", "turnsOverFrame",
        "callbackDelayP99Ms", "pastTargetFrames", "notReadyFrames", "notReadyMax", "nonRigidMax", "restDriftMax", "awayApplyDriftMax",
        "touchRowDriftMax", "newestGapMin", "newestGapMax", "dockTravel", "offsetTravel", "kinds", "touches", "applies", "start", "index",
        "applyMaxMs", "applyTotalMs", "notReadyRunMax", "memoryMaxMB",
    ]

    private func compact(_ window: [String: Any]) -> [String: Any] {
        window.filter { Self.windowKeys.contains($0.key) }
    }

    // MARK: Coverage

    private func covered(_ feature: String, _ status: String) {
        coverage.append(["clip": clip, "feature": feature, "status": status])
    }

    /// A feature the fixture is built to show: acted on with the expected
    /// effect, or the test fails.
    private func require(_ feature: String, _ ok: Bool, _ detail: @autoclosure () -> String) {
        let text = detail()
        XCTAssertTrue(ok, "\(clip) \(feature): \(text)")
        covered(feature, ok ? "acted: \(text)" : "FAILED: \(text)")
    }

    /// Acted on; the effect is judged from the named screenshots.
    private func actedVisually(_ feature: String, _ shots: String) {
        covered(feature, "acted, judged visually: \(shots)")
    }

    /// Not exercised, and why. Never a pass.
    private func notCovered(_ feature: String, _ reason: String) {
        covered(feature, "NOT COVERED: \(reason)")
        attach("\(clip) not covered", "\(feature): \(reason)")
    }

    private func kinds(_ window: [String: Any]) -> [String] { window["kinds"] as? [String] ?? [] }

    // MARK: Steps

    enum Expect {
        /// A scroll: nothing moves the rows once it has come to rest.
        case scroll
        /// The reader is away from the newest message while content changes.
        case away
        /// A tap on a row: the tapped row stays where it was.
        case pin
        /// Anything else: recorded, not judged.
        case none
    }

    /// Runs an action and records the windows it produced: acts, waits
    /// `quiet` seconds without reading the app, then reads once a second
    /// until the windows are on disk.
    @discardableResult
    private func step(_ name: String, quiet: TimeInterval = 2.5, expect: Expect = .none, requireWindow: Bool = true,
                      _ action: () -> Void) -> [[String: Any]] {
        let before = known
        mark(name)
        touchedLast = false
        flungLast = false
        action()
        // A fling coasts for about three seconds on an iPhone 12, and its
        // window closes half a second after: a read before then would land
        // in the window's frames.
        Thread.sleep(forTimeInterval: flungLast ? max(quiet, 4.5) : quiet)
        // A window that closed just before the action (motion the last
        // step left behind) doesn't close a touch's step: that waits for a
        // window with the touch in it.
        let touched = touchedLast
        let closed = wait(requireWindow ? 15 : 4, every: 1) {
            let s = state()
            guard int(s["windowCount"]) > before, (s["moving"] as? Bool) == false else { return false }
            return !touched || windows().dropFirst(before).contains { int($0["touches"]) > 0 }
        }
        let all = windows()
        let added = Array(all.dropFirst(before))
        known = max(known, all.count)
        steps.append(["step": name, "windows": added.map(compact)])
        if requireWindow {
            XCTAssertTrue(closed && !added.isEmpty, "\(clip) \(name): no closed action window")
        }
        // The launch's own window (index 0) is the first draw: reported, not
        // judged here.
        for window in added where int(window["index"]) > 0 {
            XCTAssertEqual(int(window["notReadyMax"]), 0, "\(clip) \(name): a mounted row on screen was not drawn in \(int(window["notReadyFrames"])) frames")
            if int(window["notReadyMax"]) > 0 { attach("\(clip) \(name) not-ready rows", "\(state()["notReadyLast"] ?? [])") }
            switch expect {
            case .scroll: XCTAssertLessThanOrEqual(number(window["restDriftMax"]), 0.5, "\(clip) \(name): rows moved at rest")
            case .away: XCTAssertLessThanOrEqual(number(window["awayApplyDriftMax"]), 0.5, "\(clip) \(name): the reader's rows moved on an update")
            case .pin: XCTAssertLessThanOrEqual(number(window["touchRowDriftMax"]), 1, "\(clip) \(name): the tapped row moved")
            case .none: break
            }
        }
        if Self.aimThroughSpringboard, touchedLast, !added.isEmpty, added.allSatisfy({ int($0["touches"]) == 0 }) {
            Self.aimThroughSpringboard = false
            XCTFail("\(clip) \(name): a touch aimed through SpringBoard did not reach the app; aiming through the app from now on")
        }
        return added
    }

    // MARK: Touches

    private func at(_ point: CGPoint) -> XCUICoordinate {
        // Face up or unknown counts as portrait: only a rotation this suite
        // made moves the app's frame off SpringBoard's.
        let root: XCUIElement = Self.aimThroughSpringboard && !XCUIDevice.shared.orientation.isLandscape ? springboard : app
        return root.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: point.x, dy: point.y))
    }

    private func drag(_ from: CGPoint, _ to: CGPoint, velocity: CGFloat, hold: TimeInterval = 0, press: TimeInterval = 0.02) {
        touchedLast = true
        at(from).press(forDuration: press, thenDragTo: at(to), withVelocity: XCUIGestureVelocity(rawValue: velocity), thenHoldForDuration: hold)
    }

    private func tap(_ point: CGPoint) {
        touchedLast = true
        at(point).tap()
    }

    private func hold(_ point: CGPoint, seconds: TimeInterval = 1) {
        touchedLast = true
        at(point).press(forDuration: seconds)
    }

    /// The header's back button, top left, on the chat and on screens it
    /// pushes; aimed by position so it reads nothing.
    private func back() {
        tap(CGPoint(x: 36, y: 69))
    }

    /// A fling: back through the history (`older`) or towards the newest.
    private func fling(older: Bool, velocity: CGFloat = 3000) {
        flungLast = true
        let x = size.width / 2
        let (from, to) = older ? (size.height * 0.3, size.height * 0.75) : (size.height * 0.7, size.height * 0.25)
        drag(CGPoint(x: x, y: from), CGPoint(x: x, y: to), velocity: velocity)
    }

    /// A drag that ends held still, so it leaves no momentum.
    private func move(older: Bool, by distance: CGFloat) {
        let x = size.width * 0.5
        let middle = size.height * 0.5
        let from = middle + (older ? -distance / 2 : distance / 2)
        let to = middle + (older ? distance / 2 : -distance / 2)
        drag(CGPoint(x: x, y: from), CGPoint(x: x, y: to), velocity: 700, hold: 0.25)
    }

    // MARK: Targets

    private struct Hit {
        var row: String
        var action: String
        var frame: CGRect
        var center: CGPoint { CGPoint(x: frame.midX, y: frame.midY) }
    }

    private func hits(_ report: [String: Any], hold: Bool? = nil) -> [Hit] {
        (report["hits"] as? [[String: Any]] ?? []).compactMap { entry in
            guard let frame = rect(entry["f"]), let action = entry["a"] as? String, let row = entry["row"] as? String else { return nil }
            if let hold, (entry["hold"] as? Bool) != hold { return nil }
            return Hit(row: row, action: action, frame: frame)
        }
    }

    /// A target in the band of the list between the header and the dock.
    private func reachable(_ frame: CGRect, in report: [String: Any]) -> Bool {
        let list = rect(report["list"]) ?? CGRect(origin: .zero, size: size)
        let dockTop = rect(report["dock"])?.minY ?? list.maxY
        return frame.midY > list.minY + 110 && frame.midY < min(list.maxY, dockTop) - 20 && frame.height >= 8
    }

    /// The first reachable hit matching `predicate`, moving through the
    /// history (held drags, no momentum) up to `moves` times to find it.
    /// A fixture feature missing from the screen fails the test when
    /// `required`, and is recorded as not covered otherwise.
    private func find(_ what: String, moves: Int = 8, older: Bool = true, hold: Bool? = nil, required: Bool = true,
                      _ predicate: (Hit) -> Bool) -> Hit? {
        for attempt in 0...moves {
            let report = controls()
            if let hit = hits(report, hold: hold).first(where: { predicate($0) && reachable($0.frame, in: report) }) { return hit }
            guard attempt < moves else { break }
            step("seek \(what) \(attempt + 1)", quiet: 1.2, expect: .scroll) { move(older: older, by: size.height * 0.35) }
        }
        missing(what, moves: moves, required: required)
        return nil
    }

    private func missing(_ what: String, moves: Int, required: Bool) {
        if required {
            require(what, false, "not found on screen in \(moves) moves")
        } else {
            notCovered(what, "not on screen in this fixture after \(moves) moves")
        }
    }

    private func natives(_ report: [String: Any]) -> [[String: Any]] {
        report["native"] as? [[String: Any]] ?? []
    }

    /// The first reachable native view of `kind` matching `predicate`,
    /// moving through the history to find it, like `find`.
    private func seekNative(_ what: String, kind: String, moves: Int = 8, older: Bool = true, required: Bool = true,
                            _ predicate: ([String: Any], CGRect) -> Bool = { _, _ in true }) -> (native: [String: Any], frame: CGRect)? {
        for attempt in 0...moves {
            let report = controls()
            for native in natives(report) where (native["k"] as? String) == kind {
                if let frame = rect(native["f"]), reachable(frame, in: report), predicate(native, frame) { return (native, frame) }
            }
            guard attempt < moves else { break }
            step("seek \(what) \(attempt + 1)", quiet: 1.2, expect: .scroll) { move(older: older, by: size.height * 0.35) }
        }
        missing(what, moves: moves, required: required)
        return nil
    }

    /// A horizontal strip (code, a table, a diff line) wider than its box.
    private func wideStrip(_ native: [String: Any], _ frame: CGRect) -> Bool {
        guard (native["vertical"] as? Bool) == false, let content = native["content"] as? [NSNumber], content.count == 2 else { return false }
        return CGFloat(content[0].doubleValue) > frame.width + 4
    }

    /// The part of `frame` a finger can reach, as `reachable` judges a
    /// target: below the header and above the dock; nil when too little.
    private func reachablePart(_ frame: CGRect, in report: [String: Any]) -> CGRect? {
        let list = rect(report["list"]) ?? CGRect(origin: .zero, size: size)
        let top = list.minY + 110
        let bottom = min(list.maxY, rect(report["dock"])?.minY ?? list.maxY) - 20
        let part = frame.intersection(CGRect(x: list.minX, y: top, width: list.width, height: max(0, bottom - top)))
        return part.isNull || part.height < 24 ? nil : part
    }

    /// A reachable Show more bar in `row`'s diff.
    private func showMoreBar(in report: [String: Any], row: String) -> CGRect? {
        natives(report).filter { ($0["k"] as? String) == "showMore" && ($0["row"] as? String) == row }
            .compactMap { rect($0["f"]) }.first { reachable($0, in: report) }
    }

    /// The rows each of `row`'s diffs holds back behind Show more, as the
    /// probe reads them from the diff's plan.
    private func hiddenRows(in report: [String: Any], row: String) -> [Int] {
        natives(report).filter { ($0["k"] as? String) == "diffFile" && ($0["row"] as? String) == row }.map { int($0["hiddenRows"]) }
    }

    /// `row` as the probe reports it: its frame in the window, its plan's
    /// height, and whether it draws natively (taller than 4096 points, or
    /// live views under later marks).
    private func rowEntry(_ id: String, in report: [String: Any]) -> (frame: CGRect, height: CGFloat, native: Bool)? {
        guard let row = (report["rows"] as? [[String: Any]] ?? []).first(where: { ($0["id"] as? String) == id }),
              let frame = rect(row["f"]) else { return nil }
        return (frame, number(row["h"]), (row["native"] as? Bool) ?? false)
    }

    /// Whether `row` goes on below the top of the dock.
    private func rowEndsBelowDock(_ id: String) -> Bool {
        let report = controls()
        guard let row = (report["rows"] as? [[String: Any]] ?? []).first(where: { ($0["id"] as? String) == id }),
              let frame = rect(row["f"]) else { return false }
        return frame.maxY > (rect(report["dock"])?.minY ?? size.height) - 20
    }

    private func offset(_ native: [String: Any]?) -> CGPoint {
        guard let values = native?["offset"] as? [NSNumber], values.count == 2 else { return CGPoint(x: CGFloat.nan, y: .nan) }
        return CGPoint(x: values[0].doubleValue, y: values[1].doubleValue)
    }

    /// The scroller of `row` now nearest to where `frame` was.
    private func scroller(near frame: CGRect, in row: Any?) -> [String: Any]? {
        natives(controls()).filter { ($0["row"] as? String) == (row as? String) && ($0["k"] as? String) == "scroller" }
            .min { abs((rect($0["f"])?.minY ?? .infinity) - frame.minY) < abs((rect($1["f"])?.minY ?? .infinity) - frame.minY) }
    }

    /// The scroller of `row` now, matched by direction.
    private func scroller(in row: Any?, vertical: Bool) -> [String: Any]? {
        natives(controls()).first { ($0["row"] as? String) == (row as? String) && ($0["k"] as? String) == "scroller" && ($0["vertical"] as? Bool) == vertical }
    }

    /// A row's height as laid out: the plan's for UltraList, the frame's
    /// otherwise; NaN when it isn't on screen.
    private func rowHeight(_ id: String) -> CGFloat {
        guard let row = (controls()["rows"] as? [[String: Any]] ?? []).first(where: { ($0["id"] as? String) == id }) else { return .nan }
        if let height = row["h"] as? NSNumber { return CGFloat(height.doubleValue) }
        return rect(row["f"])?.height ?? .nan
    }

    private func rowCount() -> Int { int(state()["rows"]) }

    private func toNewest() {
        for index in 1...2 { step("towards newest \(index)", quiet: 2.5, expect: .scroll) { fling(older: false, velocity: 4000) } }
    }

    private func newest(_ prefix: String) -> Hit? {
        let report = controls()
        return hits(report).filter { $0.action.hasPrefix(prefix) && reachable($0.frame, in: report) }.max { $0.frame.minY < $1.frame.minY }
    }

    // MARK: Smoke

    /// Device, signing and capture: the long chat on UltraList, a fling
    /// back and one forward.
    func testSmokeLongFling() {
        prepare()
        defer { finish() }
        launchChat("long", clip: "smoke")
        assertReady("smoke")
        screenshot("newest")
        step("fling back", quiet: 3, expect: .scroll) { fling(older: true) }
        screenshot("after-fling-back")
        step("fling forward", quiet: 3, expect: .scroll) { fling(older: false) }
        screenshot("after-fling-forward")
    }

    // MARK: C1 Long history, composer and keyboard

    func testC1LongKeyboardAndHistory() {
        prepare()
        defer { finish() }
        runLong(ultra: true, clip: "c1-long")
    }

    /// The same clip on the default renderer, for comparison.
    func testL1LegacyLongKeyboardAndHistory() {
        prepare()
        defer { finish() }
        runLong(ultra: false, clip: "l1-legacy-long")
    }

    private func runLong(ultra: Bool, clip: String) {
        launchChat("long", clip: clip, ultra: ultra, extra: ["-keyboard"])
        assertReady("open", ultra: ultra)
        let keyboardUp = wait(10) { number(scrollProbe()["keyboardTop"]) < size.height - 150 }
        Thread.sleep(forTimeInterval: 1)
        step("keyboard shown", quiet: 0.5, requireWindow: false) {}
        screenshot("01-keyboard-up")
        require("keyboard up on open", keyboardUp, "keyboardTop \(number(scrollProbe()["keyboardTop"]))")

        step("type three lines", quiet: 1.5) { app.typeText("A longer note for the agent\nwith a second line\nand a third one") }
        screenshot("02-composer-three-lines")

        var probe = scrollProbe()
        let dockTop = number(probe["dockMinY"])
        let keyboardTop = number(probe["keyboardTop"])
        let x = size.width / 2
        // The finger carries the dock; released still, the keyboard returns
        // unless the dock's bottom reached the screen's edge. A third of the
        // way there, so it returns even with three lines in the composer.
        let dock = keyboardTop - dockTop
        let partial = keyboardTop + (size.height - dock - keyboardTop) / 3 - dock
        step("partial dismiss released", quiet: 2) {
            drag(CGPoint(x: x, y: dockTop - 110), CGPoint(x: x, y: max(dockTop - 40, partial)), velocity: 300, hold: 0.4)
        }
        probe = scrollProbe()
        attach("\(clip) partial dismiss touch", "\(probe["lastTouch"] ?? [:]) keyboardTop \(probe["keyboardTop"] ?? "")")
        screenshot("03-after-partial-dismiss")
        let returned = number(probe["keyboardTop"])
        require("partial keyboard drag returns", abs(returned - keyboardTop) <= 2,
                "keyboard top \(keyboardTop) → \(returned) after a release a third of the way to the edge")

        let dockNow = number(probe["dockMinY"])
        step("interactive dismiss", quiet: 2) {
            drag(CGPoint(x: x, y: dockNow - 110), CGPoint(x: x, y: size.height - 4), velocity: 250, hold: 0.3)
        }
        probe = scrollProbe()
        let touch = probe["lastTouch"] as? [String: Any] ?? [:]
        attach("\(clip) dismiss touch", "\(touch)")
        let finger = number(touch["fingerTravelWithKeyboard"]), content = number(touch["offsetTravelWithKeyboard"])
        require("interactive keyboard dismiss", finger > 80 && abs(content / finger - 1) <= 0.15,
                "content \(content) for a finger's \(finger) while the keyboard moved (needs > 80 and a ratio within 0.15 of 1)")
        screenshot("04-keyboard-dismissed")

        // The dismissal carried the conversation with the finger.
        if abs(number(state()["visibleMinY"])) > 1 {
            let jump = app.buttons["Scroll to bottom"]
            if jump.exists {
                let frame = jump.frame
                step("back to newest", quiet: 2.5) { tap(CGPoint(x: frame.midX, y: frame.midY)) }
            }
        }
        step("pull past newest", quiet: 2, expect: .scroll) {
            drag(CGPoint(x: x, y: size.height * 0.62), CGPoint(x: x, y: size.height * 0.38), velocity: 500)
        }
        require("pull past newest springs back", abs(number(state()["visibleMinY"])) <= 1, "visibleMinY \(number(state()["visibleMinY"]))")

        for index in 1...6 {
            step("fling back \(index)", quiet: 2.5, expect: .scroll) { fling(older: true) }
        }
        screenshot("05-deep-history")
        step("fling forward", quiet: 2.5, expect: .scroll) { fling(older: false) }
        step("slow drag back", quiet: 1.5, expect: .scroll) { move(older: true, by: size.height * 0.4) }
        screenshot("06-history-at-rest")

        let jump = app.buttons["Scroll to bottom"]
        if jump.exists {
            let frame = jump.frame
            step("jump to newest", quiet: 2.5) { tap(CGPoint(x: frame.midX, y: frame.midY)) }
            require("jump to newest", abs(number(state()["visibleMinY"])) <= 1, "visibleMinY \(number(state()["visibleMinY"]))")
        } else {
            require("jump to newest", false, "no jump-to-newest button deep in the history")
        }
        screenshot("07-back-at-newest")
    }

    // MARK: C2 Streaming

    func testC2LiveStreamHistoryAndSend() {
        prepare()
        defer { finish() }
        // The reply starts 0.8 s after the chat subscribes. Nothing reads the
        // app until it has finished: a read stalls the stream's frames.
        launchChat("live", clip: "c2-live")
        Thread.sleep(forTimeInterval: 1.4)
        mark("streaming")
        screenshot("01-streaming-at-newest")
        mark("drag into history while streaming")
        move(older: true, by: size.height * 0.45)
        Thread.sleep(forTimeInterval: 0.8)
        screenshot("02-history-while-streaming")
        mark("fling while streaming")
        fling(older: true, velocity: 1500)
        Thread.sleep(forTimeInterval: 1.5)
        screenshot("03-history-while-streaming-2")
        Thread.sleep(forTimeInterval: 4)
        let streamed = step("stream ends away from newest", quiet: 0.5, expect: .away) {}
        // The drag and the fling ran while the reply streamed in: windows
        // with touches and applies, and momentum, must be there.
        let touched = streamed.filter { int($0["touches"]) > 0 }
        require("read history while a reply streams",
                touched.contains { kinds($0).contains("apply") } && touched.contains { kinds($0).contains("momentum") },
                "windows \(streamed.map { "\(int($0["index"])): \(kinds($0)) touches \(int($0["touches"])) applies \(int($0["applies"]))" })")
        assertReady("after stream")
        screenshot("04-after-stream-in-history")

        let jump = app.buttons["Scroll to bottom"]
        if jump.exists {
            let frame = jump.frame
            step("jump to newest", quiet: 2) { tap(CGPoint(x: frame.midX, y: frame.midY)) }
            require("jump to newest", abs(number(state()["visibleMinY"])) <= 1, "visibleMinY \(number(state()["visibleMinY"]))")
        } else {
            require("jump to newest", false, "no jump-to-newest button in the history")
        }
        screenshot("05-finished-reply")

        // The live chat's agent stays at work, so it refuses a send by
        // design: sending is the markdown chat's, whose agent is idle.
        launchChat("markdown", clip: "c2-send", extra: ["-keyboard"])
        assertReady("open")
        var keyboardUp = wait(5) { number(scrollProbe()["keyboardTop"]) < size.height - 150 }
        if !keyboardUp {
            // The composer didn't take focus by itself: a finger gives it.
            let field = app.textViews.firstMatch.frame
            step("focus composer", quiet: 1.5) { tap(CGPoint(x: field.midX, y: field.midY)) }
            keyboardUp = wait(5) { number(scrollProbe()["keyboardTop"]) < size.height - 150 }
        }
        Thread.sleep(forTimeInterval: 1)
        require("keyboard up to send", keyboardUp, "keyboardTop \(number(scrollProbe()["keyboardTop"]))")
        app.typeText("Walk me through the anchor with the keyboard up")
        let send = app.buttons["Send"]
        XCTAssertTrue(send.exists, "a Send button")
        let sendFrame = send.frame
        let before = rowCount()
        let sent = step("send with the keyboard up", quiet: 8) { tap(CGPoint(x: sendFrame.midX, y: sendFrame.midY)) }
        screenshot("06-reply-with-keyboard")
        require("send and stream a reply at newest", rowCount() > before + 1 && sent.contains { kinds($0).contains("apply") },
                "rows \(before) → \(rowCount()), windows \(sent.map { kinds($0) })")
        require("the reply stays at newest above the keyboard", abs(number(state()["visibleMinY"])) <= 1, "visibleMinY \(number(state()["visibleMinY"]))")

        step("dismiss keyboard", quiet: 2) {
            drag(CGPoint(x: size.width / 2, y: size.height * 0.3), CGPoint(x: size.width / 2, y: size.height - 4), velocity: 1500)
        }
        screenshot("07-keyboard-dismissed")
        if let copy = find("copy the streamed reply", moves: 3, older: false, { $0.action.hasPrefix("copy:") }) {
            mark("copy the newest reply")
            tap(copy.center)
            Thread.sleep(forTimeInterval: 0.3)
            screenshot("08-copy-tick")
            Thread.sleep(forTimeInterval: 1.8)
            screenshot("09-copy-reset")
            step("copy settles", quiet: 0.3, requireWindow: false) {}
            actedVisually("copy the streamed reply", "08-copy-tick, 09-copy-reset")
        }
    }

    // MARK: C3 Tools and permissions

    func testC3ToolsPermissionsDiffs() {
        prepare()
        defer { finish() }
        launchChat("tools", clip: "c3-tools")
        assertReady("open")
        screenshot("01-newest-pending-permissions")

        if let allow = find("allow a permission", moves: 3, { $0.action == "permission:perm-edit:allow" }) {
            // Near the newest message the list keeps the newest edge: an
            // answered card that shrinks moves its top. Recorded, not judged.
            step("allow the edit", quiet: 1.5) { tap(allow.center) }
            screenshot("02-edit-allowed")
            let left = hits(controls()).filter { $0.action.hasPrefix("permission:perm-edit:") }.count
            require("allow a permission", left == 0, "\(left) of the edit's permission buttons left after Allow")
        }
        if let deny = find("deny a permission", moves: 3, older: false, { $0.action == "permission:perm-bash:deny" }) {
            step("deny the bash", quiet: 1.5) { tap(deny.center) }
            screenshot("03-bash-denied")
            let left = hits(controls()).filter { $0.action.hasPrefix("permission:perm-bash:") }.count
            require("deny a permission", left == 0, "\(left) of the bash's permission buttons left after Deny")
        }
        if let list = seekNative("a permission list taller than its box", kind: "scroller", moves: 0, required: false, { native, frame in
            guard (native["vertical"] as? Bool) == true, let content = native["content"] as? [NSNumber], content.count == 2 else { return false }
            return CGFloat(content[1].doubleValue) > frame.height + 4
        }) {
            let frame = list.frame
            step("scroll a permission list", quiet: 1.5) {
                drag(CGPoint(x: frame.midX, y: frame.maxY - 10), CGPoint(x: frame.midX, y: frame.minY + 10), velocity: 600, hold: 0.2)
            }
            let after = offset(scroller(in: list.native["row"], vertical: true)).y
            require("scroll a permission list", after > offset(list.native).y + 10, "offset \(offset(list.native).y) → \(after)")
            screenshot("04-permission-list-scrolled")
        }

        if let group = find("open a tool group", moves: 10, required: false, { $0.action.hasPrefix("group:") }) {
            let before = rowCount()
            step("open a group", quiet: 1.5, expect: .pin) { tap(group.center) }
            screenshot("05-group-open")
            let after = rowCount()
            require("open a tool group", after > before, "rows \(before) → \(after)")
        }
        if let tool = find("open a tool", moves: 6, { $0.action.hasPrefix("tool:") }) {
            let before = rowHeight(tool.row)
            step("open a tool mid-history", quiet: 1.5, expect: .pin) { tap(tool.center) }
            screenshot("06-tool-open")
            let opened = rowHeight(tool.row)
            require("open a tool", abs(opened - before) > 1, "row height \(before) → \(opened)")
            let report = controls()
            if let same = hits(report).first(where: { $0.action == tool.action && reachable($0.frame, in: report) }) {
                step("close the tool", quiet: 1.5, expect: .pin) { tap(same.center) }
                screenshot("07-tool-closed")
                let closed = rowHeight(tool.row)
                require("close a tool", abs(closed - before) <= 1, "row height \(before) → \(opened) → \(closed)")
            } else {
                require("close a tool", false, "its toggle went out of reach once open")
            }
        }

        // A diff's Show more and its sideways lines are inside a tool:
        // open the tools on screen one at a time, and close each where it
        // opened, until both have shown. A diff past its first lines ends
        // in Show more, below the screen when the diff is tall: that tool
        // opens again and the list follows it down to the bar.
        var showMoreDone = false, stripDone = false
        var tried = Set<String>()
        // Every opened diff's held-back rows, by tool.
        var held: [String: [Int]] = [:]
        for _ in 0..<12 where !(showMoreDone && stripDone) {
            let report = controls()
            guard let tool = hits(report).first(where: { $0.action.hasPrefix("tool:") && !tried.contains($0.action) && reachable($0.frame, in: report) }) else {
                step("seek more tools", quiet: 1.2, expect: .scroll) { move(older: true, by: size.height * 0.35) }
                continue
            }
            tried.insert(tool.action)
            step("open \(tool.action)", quiet: 1.5) { tap(tool.center) }
            let opened = controls()
            let hidden = hiddenRows(in: opened, row: tool.row)
            if !hidden.isEmpty { held[tool.action] = hidden }
            let strips = natives(opened).compactMap { native -> (native: [String: Any], frame: CGRect, part: CGRect)? in
                guard native["k"] as? String == "scroller", let frame = rect(native["f"]), wideStrip(native, frame),
                      let part = reachablePart(frame, in: opened) else { return nil }
                return (native, frame, part)
            }
            if !stripDone, let found = strips.first {
                let strip = found.native, frame = found.frame, part = found.part
                step("pan a strip sideways", quiet: 1.5) {
                    drag(CGPoint(x: part.maxX - 20, y: part.midY), CGPoint(x: part.minX + 20, y: part.midY), velocity: 600, hold: 0.2)
                }
                let after = offset(scroller(near: frame, in: strip["row"])).x
                require("pan a strip sideways", after > offset(strip).x + 10, "offset \(offset(strip).x) → \(after)\(strip["diff"] != nil ? " (a diff's lines)" : "")")
                screenshot("09-strip-panned")
                stripDone = true
            }
            var bar = showMoreBar(in: controls(), row: tool.row)
            let tallDiff = bar == nil && rowEndsBelowDock(tool.row)
                && natives(opened).contains { ($0["row"] as? String) == tool.row && $0["diff"] != nil }
            var isOpen = true
            if !showMoreDone, tallDiff {
                isOpen = !closeTool(tool.action)
                let again = controls()
                if !isOpen, let toggle = hits(again).first(where: { $0.action == tool.action && reachable($0.frame, in: again) }) {
                    step("open \(tool.action) again", quiet: 1.5) { tap(toggle.center) }
                    isOpen = true
                }
            }
            var followed = 0
            if !showMoreDone, isOpen {
                while bar == nil, tallDiff, followed < 6, rowEndsBelowDock(tool.row) {
                    followed += 1
                    step("follow \(tool.action) down \(followed)", quiet: 1.2, expect: .scroll) { move(older: false, by: size.height * 0.35) }
                    bar = showMoreBar(in: controls(), row: tool.row)
                }
                if let bar {
                    let before = rowHeight(tool.row)
                    step("show more diff lines", quiet: 1.5) { tap(CGPoint(x: bar.midX, y: bar.midY)) }
                    screenshot("08-diff-show-more")
                    let after = rowHeight(tool.row)
                    require("a diff's Show more", after > before + 1, "row height \(before) → \(after)")
                    showMoreDone = true
                }
            }
            if isOpen { closeTool(tool.action, backUp: followed > 0 ? followed + 2 : 0) }
        }
        // Every diff here shows all its lines (the Write's 120 added lines
        // are one change block, and the cut moves to its end): Show more
        // is C10's. A diff that held lines back and never showed its bar
        // still fails.
        let summary = held.sorted { $0.key < $1.key }.map { "\($0.key) \($0.value)" }.joined(separator: ", ")
        if !showMoreDone, !held.isEmpty, held.values.allSatisfy({ $0.allSatisfy { $0 == 0 } }) {
            notCovered("a diff's Show more", "no hidden lines: every diff in \(tried.count) opened tools shows all its rows (\(summary)); covered by C10")
        } else if !showMoreDone {
            require("a diff's Show more", false, "no Show more in \(tried.count) opened tools; held back: \(summary.isEmpty ? "no diffs read" : summary)")
        }
        if !stripDone { require("pan a strip sideways", false, "no strip wider than its box in \(tried.count) opened tools") }
        step("fling back", quiet: 2.5, expect: .scroll) { fling(older: true) }
        step("catch momentum and pan sideways", quiet: 2) {
            fling(older: false, velocity: 1800)
            drag(CGPoint(x: size.width * 0.8, y: size.height * 0.45), CGPoint(x: size.width * 0.2, y: size.height * 0.45), velocity: 800, hold: 0.1)
        }
        screenshot("10-after-catch")
    }

    /// Closes an open tool by its toggle, first backing up toward older
    /// messages up to `backUp` times when the list followed the tool down;
    /// false when the toggle stayed out of reach.
    @discardableResult
    private func closeTool(_ action: String, backUp: Int = 0) -> Bool {
        var report = controls()
        var moves = 0
        while moves < backUp, !hits(report).contains(where: { $0.action == action && reachable($0.frame, in: report) }) {
            moves += 1
            step("back up to \(action) \(moves)", quiet: 1.2, expect: .scroll) { move(older: true, by: size.height * 0.35) }
            report = controls()
        }
        guard let toggle = hits(report).first(where: { $0.action == action && reachable($0.frame, in: report) }) else { return false }
        step("close \(action)", quiet: 1.5) { tap(toggle.center) }
        return true
    }

    // MARK: C10 A diff's Show more

    /// The newest message is a Write of 301 added lines: its diff shows 280
    /// and holds back 21. At the newest message the list keeps the newest
    /// edge, so the open tool grows upwards and its bar ends just above the
    /// composer. After Show more the reader's place is the newest edge (the
    /// row's bottom stays put) or, away from it, the tapped row's top.
    func testC10DiffShowMore() {
        prepare()
        defer { finish() }
        launchChat("showMore", clip: "c10-show-more")
        assertReady("open")
        screenshot("01-newest-write")
        guard let tool = find("open the Write", moves: 2, { $0.action.hasPrefix("tool:") }) else { return }
        step("open the Write", quiet: 2) { tap(tool.center) }
        screenshot("02-write-open")
        var report = controls()
        let hidden = hiddenRows(in: report, row: tool.row)
        require("a diff holds lines back", hidden.contains { $0 > 0 }, "held back \(hidden)")
        guard let opened = rowEntry(tool.row, in: report) else {
            require("a diff's Show more", false, "the Write's row went off screen once open")
            return
        }
        covered("the open Write's drawing", "\(opened.native ? "native canvas" : "tiled bitmaps"), plan \(opened.height) pt")
        var bar = showMoreBar(in: report, row: tool.row)
        var followed = 0
        while bar == nil, followed < 4, rowEndsBelowDock(tool.row) {
            followed += 1
            step("follow the Write down \(followed)", quiet: 1.2, expect: .scroll) { move(older: false, by: size.height * 0.35) }
            report = controls()
            bar = showMoreBar(in: report, row: tool.row)
        }
        guard let bar, let before = rowEntry(tool.row, in: report) else {
            let row = rowEntry(tool.row, in: report)
            require("a diff's Show more", false, "no reachable bar after \(followed) moves: row \(row.map { "\($0.frame)" } ?? "off screen"), dock \(rect(report["dock"]).map { "\($0)" } ?? "none")")
            return
        }
        let atNewest = number(state()["visibleMinY"]) <= 0.5
        step("show more diff lines", quiet: 2, expect: atNewest ? .none : .pin) { tap(CGPoint(x: bar.midX, y: bar.midY)) }
        screenshot("03-diff-shown-more")
        report = controls()
        let hiddenAfter = hiddenRows(in: report, row: tool.row)
        guard let after = rowEntry(tool.row, in: report) else {
            require("a diff's Show more", false, "the Write's row went off screen after Show more")
            return
        }
        require("a diff's Show more", after.height > before.height + 1 && !hiddenAfter.isEmpty && hiddenAfter.allSatisfy { $0 == 0 },
                "plan \(before.height) → \(after.height) pt, held back \(hidden) → \(hiddenAfter), bar at \(bar)")
        covered("the expanded Write's drawing", "\(after.native ? "native canvas" : "tiled bitmaps"), plan \(after.height) pt")
        if atNewest {
            let distance = number(state()["visibleMinY"])
            require("Show more keeps the newest edge", abs(after.frame.maxY - before.frame.maxY) <= 1 && distance <= 0.5,
                    "row bottom \(before.frame.maxY) → \(after.frame.maxY), distance from newest \(distance)")
        } else {
            require("Show more keeps the tapped row's top", abs(after.frame.minY - before.frame.minY) <= 1,
                    "row top \(before.frame.minY) → \(after.frame.minY) after \(followed) moves")
        }
    }

    // MARK: C4 Markdown, links, copy, pictures

    func testC4MarkdownLinksCopyPictures() {
        prepare()
        defer { finish() }
        launchChat("markdown", clip: "c4-markdown")
        assertReady("open")
        screenshot("01-newest")

        if let copy = newest("copy:") {
            mark("copy the newest reply")
            tap(copy.center)
            Thread.sleep(forTimeInterval: 0.3)
            screenshot("02-copy-tick")
            Thread.sleep(forTimeInterval: 1.8)
            screenshot("03-copy-reset")
            step("copy settles", quiet: 0.3) {}
            actedVisually("copy a reply", "02-copy-tick, 03-copy-reset (the pasteboard isn't read: that would raise the paste prompt)")
        } else {
            require("copy a reply", false, "no copy button on the newest reply")
        }
        if let held = find("long-press a message", moves: 3, hold: true, { $0.action == "markdownSelectable" || $0.action == "copyMenu" }) {
            step("long press \(held.action)", quiet: 1.2) { hold(held.center) }
            screenshot("04-long-press-menu")
            let copy = app.descendants(matching: .any)["Copy"].firstMatch
            let menu = copy.exists
            let selection = (state()["listInWindow"] as? Bool) == false
            require("long-press a message", menu || selection, menu ? "a Copy menu" : selection ? "the text selection screen" : "neither a menu nor the selection screen")
            if menu {
                copy.tap()
            } else if !selection {
                tap(CGPoint(x: size.width / 2, y: 150))
            }
            Thread.sleep(forTimeInterval: 1)
            screenshot("05-menu-closed")
            if (state()["listInWindow"] as? Bool) == false {
                // Markdown Copy v2 opens the text selection screen.
                back()
                XCTAssertTrue(wait(5) { (state()["listInWindow"] as? Bool) == true }, "back in the chat from the selection screen")
            }
        }
        if let option = find("choose an option", moves: 4, { $0.action.hasPrefix("option:") }) {
            screenshot("06-options")
            let before = rowCount()
            mark("choose \(option.action)")
            tap(option.center)
            Thread.sleep(forTimeInterval: 1.5)
            screenshot("07-option-sent")
            Thread.sleep(forTimeInterval: 5)
            screenshot("08-option-reply")
            step("option reply settles", quiet: 0.5) {}
            let after = rowCount()
            require("choose an option", after > before, "rows \(before) → \(after)")
        }

        // Pictures draw natively over the row: an attached file (its
        // thumbhash, then the picture) and a Markdown image from the web.
        if seekNative("an attached picture", kind: "attachment", moves: 6) != nil {
            screenshot("09-attached-pictures")
            actedVisually("an attached picture", "09-attached-pictures")
        }
        if seekNative("a Markdown web image", kind: "webImage", moves: 6) != nil {
            screenshot("10-web-image")
            actedVisually("a Markdown web image", "10-web-image (loaded from the network: a blank box is a load failure, not a pass)")
        }
        if let opener = find("open a message's own screen", moves: 0, required: false, { $0.action.hasPrefix("open:") || $0.action.hasPrefix("openFile:") }) {
            step("open \(opener.action)", quiet: 1.5) { tap(opener.center) }
            let opened = (state()["listInWindow"] as? Bool) == false
            screenshot("11-opened-screen")
            require("open a message's own screen", opened, opened ? "its screen opened" : "the chat stayed on screen")
            if opened {
                back()
                XCTAssertTrue(wait(5) { (state()["listInWindow"] as? Bool) == true }, "back in the chat")
            }
        }
        if let strip = seekNative("pan code or a table sideways", kind: "scroller", moves: 6, { wideStrip($0, $1) }) {
            let frame = strip.frame
            step("pan code or table sideways", quiet: 1.5) {
                drag(CGPoint(x: frame.maxX - 20, y: frame.midY), CGPoint(x: frame.minX + 30, y: frame.midY), velocity: 700, hold: 0.2)
            }
            let after = offset(scroller(near: strip.frame, in: strip.native["row"])).x
            require("pan code or a table sideways", after > offset(strip.native).x + 10, "offset \(offset(strip.native).x) → \(after)")
            screenshot("12-strip-panned")
        }
        step("fling away", quiet: 2.5, expect: .scroll) { fling(older: false) }
        step("fling back", quiet: 2.5, expect: .scroll) { fling(older: true) }
        screenshot("13-after-reuse")
        var opened = false
        for index in 0...4 where !opened {
            let report = controls()
            if let link = (report["links"] as? [[String: Any]])?.first(where: {
                guard let point = $0["p"] as? [NSNumber], point.count == 2 else { return false }
                return reachable(CGRect(x: point[0].doubleValue - 5, y: point[1].doubleValue - 5, width: 10, height: 10), in: report)
            }), let point = link["p"] as? [NSNumber] {
                mark("link \(link["url"] ?? "")")
                tap(CGPoint(x: point[0].doubleValue, y: point[1].doubleValue))
                opened = app.wait(for: .runningBackground, timeout: 6)
                require("open a link", opened, opened ? "\(link["url"] ?? "") opened outside the app" : "the app stayed in front")
                screenshot("14-link-opened")
                app.activate()
                Thread.sleep(forTimeInterval: 1.5)
                screenshot("15-returned")
                break
            }
            if index < 4 {
                step("seek a link \(index + 1)", quiet: 1.2, expect: .scroll) { move(older: true, by: size.height * 0.35) }
            } else {
                require("open a link", false, "no link on screen in 4 moves")
            }
        }
    }

    // MARK: C5 Questions and sending

    func testC5QuestionsAndSending() {
        prepare()
        defer { finish() }
        launchChat("question", clip: "c5-question")
        assertReady("open")
        screenshot("01-question")
        if let first = find("answer an inline question", moves: 3, { $0.action.hasPrefix("question:") }) {
            step("choose an inline option", quiet: 1) { tap(first.center) }
            let report = controls()
            if let second = hits(report).first(where: { $0.action.hasPrefix("question:") && $0.action.hasSuffix(":2") && reachable($0.frame, in: report) }) {
                step("choose another option", quiet: 1) { tap(second.center) }
            }
            screenshot("02-inline-chosen")
            let after = controls()
            if let submit = hits(after).first(where: { $0.action.hasPrefix("submit:") && reachable($0.frame, in: after) }) {
                step("submit inline answers", quiet: 1.5) { tap(submit.center) }
                screenshot("03-inline-submitted")
                actedVisually("answer an inline question", "02-inline-chosen, 03-inline-submitted")
            } else {
                require("answer an inline question", false, "no enabled submit once options were chosen")
            }
        }
        // The banner shows the oldest open question: the fixture's "Release name".
        let banner = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@ OR label BEGINSWITH %@", "Release name", "Platform")).firstMatch
        if banner.exists {
            banner.tap()
            Thread.sleep(forTimeInterval: 1.2)
            screenshot("04-question-sheet")
            for label in ["iPhone", "iPad", "The chat list"] {
                let option = app.descendants(matching: .any)[label].firstMatch
                if option.exists { option.tap() }
            }
            // The own-answer field is a plain text view under its own
            // placeholder label: the sheet's topmost text view above the
            // keyboard, the first question's (the required Release name).
            let keyboardTop = app.keyboards.firstMatch.exists ? app.keyboards.firstMatch.frame.minY : size.height
            let own = app.textViews.allElementsBoundByIndex
                .filter { $0.isHittable && $0.frame.minY > 100 && $0.frame.maxY < keyboardTop }
                .min { $0.frame.minY < $1.frame.minY }
            if let own {
                own.tap()
                app.typeText("Also the iPad mini")
                let typed = (own.value as? String ?? "").contains("Also the iPad mini")
                require("write an own answer in the sheet", typed, "field value \(typed ? "has" : "lacks") the typed answer")
            } else {
                notCovered("write an own answer in the sheet", "no 'Write an answer instead' field")
            }
            Thread.sleep(forTimeInterval: 0.8)
            screenshot("05-sheet-answer-above-keyboard")
            let submit = app.buttons["Send answer"]
            let sent = submit.exists
            if sent { submit.tap() }
            Thread.sleep(forTimeInterval: 1.5)
            screenshot("06-sheet-sent")
            let closed = !app.buttons["Send answer"].exists
            require("answer in the question sheet", sent && closed, sent ? (closed ? "sent and the sheet closed" : "the sheet stayed open") : "no Send answer")
        } else {
            require("answer in the question sheet", false, "no question banner in the dock")
        }

        launchChat("sending", clip: "c5-sending")
        assertReady("open")
        screenshot("07-pending-and-refused")
        let field = app.textViews.firstMatch.frame
        tap(CGPoint(x: field.midX, y: field.midY))
        Thread.sleep(forTimeInterval: 1)
        app.typeText("This one should fail first")
        let send = app.buttons["Send"].frame
        let before = rowCount()
        step("send a message that fails", quiet: 2.5) { tap(CGPoint(x: send.midX, y: send.midY)) }
        screenshot("08-failed")
        require("send a message", rowCount() > before, "rows \(before) → \(rowCount())")
        step("dismiss keyboard", quiet: 1.5) {
            drag(CGPoint(x: size.width / 2, y: size.height * 0.3), CGPoint(x: size.width / 2, y: size.height - 4), velocity: 1500)
        }
        // The dismissing drag carries the list back into the history: the
        // failed send is at the newest end.
        if let retry = find("retry a failed send", moves: 4, older: false, { $0.action.hasPrefix("retry:") }) {
            step("retry", quiet: 3) { tap(retry.center) }
            screenshot("09-retried")
            Thread.sleep(forTimeInterval: 5)
            screenshot("10-reply")
            step("reply settles", quiet: 0.5, requireWindow: false) {}
            let left = hits(controls()).filter { $0.action == retry.action }.count
            require("retry a failed send", left == 0, left == 0 ? "the retry is gone" : "the retry is still there")
        }
    }

    // MARK: C6 Diagrams and one giant message

    /// The rows with diagrams drawn in WebKit: the row view and its web
    /// views, by row.
    private func diagrams() -> [String: (view: String, webViews: [String])] {
        let report = controls()
        var views: [String: String] = [:]
        for row in report["rows"] as? [[String: Any]] ?? [] {
            if let id = row["id"] as? String, let object = row["object"] as? String { views[id] = object }
        }
        var found: [String: (view: String, webViews: [String])] = [:]
        for native in natives(report) where (native["k"] as? String) == "webView" {
            guard let row = native["row"] as? String, let object = native["object"] as? String else { continue }
            found[row, default: (views[row] ?? "", [])].webViews.append(object)
        }
        return found
    }

    /// The tallest row on screen: its plan height and whether it draws on
    /// the native canvas instead of tiles.
    private func tallest() -> (height: Double, native: Bool)? {
        (controls()["rows"] as? [[String: Any]] ?? []).compactMap { row -> (height: Double, native: Bool)? in
            guard let height = (row["h"] as? NSNumber)?.doubleValue else { return nil }
            return (height, (row["native"] as? Bool) ?? false)
        }.max { $0.height < $1.height }
    }

    private func memory() -> String {
        let s = state()
        return "\(s["memoryMB"] ?? -1) MB now, \(s["memoryPeakMB"] ?? -1) MB peak"
    }

    func testC6DiagramsAndGiantMessage() {
        prepare()
        defer { finish() }
        launchChat("diagrams", clip: "c6-diagrams")
        assertReady("open")
        Thread.sleep(forTimeInterval: 3)
        step("diagrams measured", quiet: 0.5, requireWindow: false) {}
        screenshot("01-diagrams")
        let first = diagrams()
        require("diagrams draw in WebKit", !first.isEmpty, "\(first.count) rows with a web view")
        step("nudge the diagrams", quiet: 1.5, expect: .scroll) { move(older: true, by: 120) }
        let nudged = diagrams()
        let kept = first.filter { nudged[$0.key]?.view == $0.value.view }
        let same = kept.filter { nudged[$0.key]?.webViews == $0.value.webViews }
        require("a diagram keeps its web view while its row stays", !kept.isEmpty && same.count == kept.count,
                "rows kept on screen \(kept.count), with the same web views \(same.count)")
        for index in 1...3 {
            step("through the diagrams \(index)", quiet: 1.5, expect: .scroll) { move(older: true, by: size.height * 0.4) }
            screenshot("02-diagrams-\(index)")
        }
        actedVisually("invalid and over-cap diagrams", "01-diagrams, 02-diagrams-1…3")
        if let mermaid = seekNative("drag inside a diagram", kind: "mermaid", moves: 4, older: false, { _, frame in frame.height > 160 }) {
            let frame = mermaid.frame
            let top = max(frame.minY, 160) + 20, bottom = min(frame.maxY, size.height - 200) - 20
            if bottom - top > 80 {
                step("drag inside a diagram", quiet: 1.5, expect: .scroll) {
                    drag(CGPoint(x: frame.midX, y: bottom), CGPoint(x: frame.midX, y: top), velocity: 600, hold: 0.2)
                }
                screenshot("03-inside-diagram")
                actedVisually("drag inside a diagram", "03-inside-diagram, and the step's offsetTravel")
            } else {
                notCovered("drag inside a diagram", "the diagram on screen is too short to drag inside")
            }
        }
        step("back to newest", quiet: 2, expect: .scroll) { fling(older: false) }
        attach("\(clip) web views", "first \(first) nudged \(nudged) back \(diagrams())")
        covered("diagram memory", memory())

        launchChat("giant", clip: "c6-giant-350", extra: ["-giantParagraphs", "350"])
        assertReady("open")
        let opened = memory()
        if let giant = tallest() {
            require("a message far over 4096 pt draws natively", giant.height > 4096 && giant.native, "height \(giant.height), native \(giant.native)")
        } else {
            require("a message far over 4096 pt draws natively", false, "no row on screen")
        }
        attach("\(clip) rows", "\(controls()["rows"] ?? [])")
        screenshot("04-giant-newest")
        for index in 1...4 { step("fling through giant \(index)", quiet: 2.5, expect: .scroll) { fling(older: true, velocity: 4000) } }
        screenshot("05-giant-deep")
        for index in 1...2 { step("fling back \(index)", quiet: 2.5, expect: .scroll) { fling(older: false, velocity: 4000) } }
        screenshot("06-giant-after")
        covered("giant message memory", "350 paragraphs: on open \(opened); after six flings \(memory())")

        // Rows either side of the 4096-point line where drawing moves from
        // tiles to the native canvas.
        launchChat("giant", clip: "c6-giant-40", extra: ["-giantParagraphs", "40"])
        assertReady("open")
        let perParagraph = max(20, (tallest()?.height ?? 0) / 40)
        for (target, over) in [(3950.0, false), (4250.0, true)] {
            let feature = over ? "a message just over 4096 pt draws natively" : "a message just under 4096 pt draws in tiles"
            var count = max(1, Int((target / perParagraph).rounded()))
            var landed: (height: Double, native: Bool)?
            for _ in 0..<4 {
                launchChat("giant", clip: "c6-giant-\(count)", extra: ["-giantParagraphs", "\(count)"])
                assertReady("open")
                guard let row = tallest() else { break }
                if (row.height > 4096) == over {
                    landed = row
                    break
                }
                let paragraphs = max(1, Int((abs(row.height - 4096) / perParagraph).rounded(.up)))
                count = max(1, count + (over ? paragraphs : -paragraphs))
            }
            guard let landed else {
                require(feature, false, "no paragraph count landed on that side")
                continue
            }
            require(feature, landed.native == over, "height \(landed.height), native \(landed.native), \(count) paragraphs")
            screenshot("07-near-threshold")
            for index in 1...2 { step("fling \(index)", quiet: 2.5, expect: .scroll) { fling(older: true, velocity: 3500) } }
            step("fling forward", quiet: 2.5, expect: .scroll) { fling(older: false, velocity: 3500) }
            screenshot("08-near-threshold-after")
            covered("memory near the threshold", "\(count) paragraphs: \(memory())")
        }
    }

    // MARK: C7 Home to chat, Details, renderer setting

    private func row(_ title: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
    }

    private func backToHome() {
        back()
        XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 10), "back on Home")
        Thread.sleep(forTimeInterval: 0.8)
    }

    func testC7HomeOpensChatsDetailsAndSetting() {
        prepare()
        defer { finish() }
        launchHome(clip: "c7-home")
        XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 20))
        Thread.sleep(forTimeInterval: 1)
        for (title, label) in [("Scroll indicator", "short"), ("Release notes", "long")] {
            for pass in ["cold", "warm"] {
                let target = row(title)
                XCTAssertTrue(target.waitForExistence(timeout: 10), title)
                let frame = target.frame
                mark("open \(label) \(pass)")
                tap(CGPoint(x: frame.midX, y: frame.midY))
                Thread.sleep(forTimeInterval: 2.5)
                assertReady("open \(label) \(pass)")
                screenshot("open-\(label)-\(pass)")
                if label == "long", pass == "cold" {
                    step("fling the opened chat", quiet: 2.5, expect: .scroll) { fling(older: true) }
                }
                if label == "short", pass == "warm" {
                    // The header's avatar, labelled with the chat's title; a
                    // worktree tab below the header can carry the same label.
                    let avatar = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", title)).allElementsBoundByIndex
                        .first { $0.frame.midX > size.width * 0.75 && $0.frame.midY < 100 && $0.frame.width < 70 }
                    if let avatar {
                        let spot = avatar.frame
                        tap(CGPoint(x: spot.midX, y: spot.midY))
                        Thread.sleep(forTimeInterval: 1.5)
                        screenshot("details")
                        let texts = app.staticTexts.allElementsBoundByIndex.prefix(40).map { $0.label }.filter { !$0.isEmpty }
                        attach("\(clip) details texts", "\(texts)")
                        require("header avatar opens Details with content", texts.count >= 4, "\(texts.count) texts")
                        back()
                        Thread.sleep(forTimeInterval: 1.2)
                    } else {
                        require("header avatar opens Details with content", false, "no header avatar")
                    }
                }
                backToHome()
            }
        }
        let opens = state()["opens"] as? [[String: Any]] ?? []
        attach("\(clip) openings", "\(opens)")
        attach("\(clip) first visual responses", "\(state()["firstVisuals"] ?? [])")
        require("open chats from Home on UltraList", opens.count == 4 && opens.allSatisfy { ($0["renderer"] as? String) == "UltraList" && number($0["readyMs"]) > 0 },
                "\(opens.count) openings: \(opens.map { "\($0["renderer"] ?? "") mount \($0["mountMs"] ?? "") visible \($0["visibleMs"] ?? "") ready \($0["readyMs"] ?? "") settled \($0["settledMs"] ?? "")" })")

        func choose(_ renderer: String) {
            app.buttons["Settings"].tap()
            XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))
            let appearance = row("Appearance,")
            XCTAssertTrue(appearance.waitForExistence(timeout: 10)); appearance.tap()
            let setting = row("Chat list renderer,")
            XCTAssertTrue(setting.waitForExistence(timeout: 10)); setting.tap()
            let choice = app.alerts.buttons[renderer]
            XCTAssertTrue(choice.waitForExistence(timeout: 10)); choice.tap()
            Thread.sleep(forTimeInterval: 0.8)
            screenshot("setting-\(renderer)")
            app.navigationBars["Appearance"].buttons.element(boundBy: 0).tap()
            XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))
            app.navigationBars["Settings"].buttons.element(boundBy: 0).tap()
            XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 10))
        }
        choose("UICollectionView")
        row("Scroll indicator").tap()
        Thread.sleep(forTimeInterval: 2.5)
        assertReady("after choosing UICollectionView", ultra: false)
        screenshot("chat-collectionview")
        backToHome()
        choose("UltraList")
        row("Scroll indicator").tap()
        Thread.sleep(forTimeInterval: 2.5)
        assertReady("after choosing UltraList")
        screenshot("chat-ultralist-again")
        app.terminate()

        launchHome(clip: "c7-home-relaunch", renderer: "stored", ultra: false)
        let chat = row("Scroll indicator")
        XCTAssertTrue(chat.waitForExistence(timeout: 20))
        chat.tap()
        Thread.sleep(forTimeInterval: 2.5)
        assertReady("relaunch keeps UltraList")
        screenshot("relaunch-ultralist")
        app.terminate()

        // Worktree tabs: a chat shows its checkout's tabs only while Home is
        // grouped by project (`ChatServices.checkout`); the seeded worktree
        // chat-nav has four. Its row on Home opens its newest chat.
        launchHome(clip: "c7-tabs", grouping: "project")
        XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 20))
        let worktree = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@ OR label BEGINSWITH %@", "chat-nav", "Scroll indicator")).firstMatch
        for _ in 0..<5 where !(worktree.exists && worktree.isHittable) {
            drag(CGPoint(x: size.width / 2, y: size.height * 0.7), CGPoint(x: size.width / 2, y: size.height * 0.35), velocity: 800, hold: 0.2)
            Thread.sleep(forTimeInterval: 0.8)
        }
        guard worktree.exists, worktree.isHittable else {
            require("switch worktree tabs", false, "no chat-nav worktree on the project-grouped Home")
            return
        }
        let worktreeFrame = worktree.frame
        mark("open the worktree")
        tap(CGPoint(x: worktreeFrame.midX, y: worktreeFrame.midY))
        Thread.sleep(forTimeInterval: 2.5)
        assertReady("worktree chat")
        screenshot("worktree-tabs")
        for (tab, shot) in [("Opening a chat", "tab-opening-a-chat"), ("Scroll indicator", "tab-scroll-indicator")] {
            let button = app.buttons.matching(NSPredicate(format: "label == %@", tab)).allElementsBoundByIndex
                .first { $0.frame.midY > 90 && $0.frame.midY < 200 }
            guard let button else {
                require("switch worktree tabs", false, "no \(tab) tab under the header")
                break
            }
            let frame = button.frame
            step("tab \(tab)", quiet: 2.5) { tap(CGPoint(x: frame.midX, y: frame.midY)) }
            assertReady("tab \(tab)")
            screenshot(shot)
            let selected = app.buttons.matching(NSPredicate(format: "label == %@", tab)).allElementsBoundByIndex.contains { $0.isSelected }
            require("switch worktree tabs", selected, "\(tab) selected \(selected)")
        }
    }

    // MARK: N1 Who owns the navigation bar

    /// The navigation bars on screen, at rest: a hidden bar isn't one.
    private func shownBars() -> [XCUIElement] {
        app.navigationBars.allElementsBoundByIndex.filter { $0.exists && $0.frame.height > 20 && $0.frame.maxY > 0 }
    }

    /// Home floats its own header with no bar, a chat has the bar in
    /// portrait, and Settings has the ordinary bar. In landscape a chat has
    /// no bar on a phone layout; a window at least 768 points wide is a
    /// tablet layout (`TabletBreakpoint`), where the chat beside the sidebar
    /// keeps its bar (`chatHidesHeaderInLandscape`).
    /// Every check is of the screen at rest. The back swipe let go early is
    /// only attempted: a swipe that never began passes the same checks, so
    /// whether it began and turned back, and any bar flashing during a
    /// push, are judged from a recorded pass.
    func testN1NavigationBarOwnership() {
        prepare()
        defer { finish() }
        // Back to portrait however the test ends, even failing in landscape.
        defer { XCUIDevice.shared.orientation = .portrait }
        XCUIDevice.shared.orientation = .portrait
        launchHome(clip: "n1-bar")
        XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 20))
        Thread.sleep(forTimeInterval: 1)
        require("Home has no navigation bar", shownBars().isEmpty, "\(shownBars().count) bars")
        screenshot("01-home")

        let target = row("Scroll indicator")
        XCTAssertTrue(target.waitForExistence(timeout: 10))
        let frame = target.frame
        mark("open portrait")
        tap(CGPoint(x: frame.midX, y: frame.midY))
        Thread.sleep(forTimeInterval: 2.5)
        assertReady("open portrait")
        require("a chat has the bar in portrait", shownBars().count == 1, "\(shownBars().map { $0.frame })")
        screenshot("02-chat-portrait")

        // From the left edge, a third of the way, held still and let go:
        // a pop that began is cancelled.
        step("attempted back swipe let go early", quiet: 2) {
            drag(CGPoint(x: 2, y: size.height * 0.5), CGPoint(x: size.width * 0.3, y: size.height * 0.5), velocity: 300, hold: 0.4)
        }
        let stayed = !app.buttons["Settings"].exists
        require("still on the chat after an attempted cancelled back swipe", stayed, "Home \(stayed ? "not shown" : "shown")")
        require("the chat has its bar after an attempted cancelled back swipe", shownBars().count == 1, "\(shownBars().map { $0.frame })")
        assertReady("after the attempted cancelled swipe")
        screenshot("03-chat-after-attempted-cancelled-swipe")

        backToHome()
        require("Home has no bar again after the chat", shownBars().isEmpty, "\(shownBars().count) bars")
        screenshot("04-home-again")

        app.buttons["Settings"].tap()
        let settings = app.navigationBars["Settings"]
        require("Settings has the ordinary bar", settings.waitForExistence(timeout: 10) && settings.frame.height > 20, "\(settings.frame)")
        screenshot("05-settings")
        settings.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 0.8)
        require("Home has no bar after Settings", shownBars().isEmpty, "\(shownBars().count) bars")

        mark("rotate landscape")
        XCUIDevice.shared.orientation = .landscapeLeft
        Thread.sleep(forTimeInterval: 2.5)
        screenshot("06-home-landscape")
        let landscapeRow = row("Scroll indicator")
        XCTAssertTrue(landscapeRow.waitForExistence(timeout: 10))
        mark("open landscape")
        landscapeRow.tap()
        Thread.sleep(forTimeInterval: 2.5)
        assertReady("open landscape")
        let width = app.windows.firstMatch.frame.width
        if width >= 768 {
            let bars = shownBars()
            require("a chat beside the sidebar has its bar in a landscape tablet layout",
                    bars.count == 1 && bars[0].frame.minX > 0, "window \(width) wide, \(bars.map { $0.frame })")
        } else {
            require("a chat has no bar in landscape", shownBars().isEmpty, "window \(width) wide, \(shownBars().map { $0.frame })")
        }
        screenshot("07-chat-landscape")
        mark("rotate portrait")
        XCUIDevice.shared.orientation = .portrait
        Thread.sleep(forTimeInterval: 2.5)
        require("the chat has its bar back in portrait", shownBars().count == 1, "\(shownBars().map { $0.frame })")
        screenshot("08-chat-portrait-again")
        backToHome()
        require("Home has no bar after the rotated chat", shownBars().isEmpty, "\(shownBars().count) bars")
        attach("\(clip) openings", "\(state()["opens"] ?? [])")
        attach("\(clip) first visual responses", "\(state()["firstVisuals"] ?? [])")
    }

    // MARK: C8 Appearance, text size, rotation, accessibility

    func testC8DarkLargeTextRotationAccessibility() {
        prepare()
        defer { finish() }
        launchChat("tools", clip: "c8-dark-tools", extra: ["-qaDark"])
        assertReady("open")
        screenshot("01-dark-tools")
        step("dark fling", quiet: 2.5, expect: .scroll) { fling(older: true) }
        screenshot("02-dark-tools-history")

        launchChat("markdown", clip: "c8-large-text", extra: ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXL"])
        assertReady("open")
        screenshot("03-large-text")
        for index in 1...2 { step("large text fling \(index)", quiet: 2.5, expect: .scroll) { fling(older: true) } }
        screenshot("04-large-text-history")
        var issues: [String] = []
        do {
            try app.performAccessibilityAudit(for: [.sufficientElementDescription, .hitRegion, .elementDetection, .trait, .textClipped]) { issue in
                issues.append("\(issue.auditType.rawValue) \(issue.compactDescription) [\(issue.element?.label.prefix(60) ?? "")]")
                return true
            }
        } catch {
            issues.append("audit failed: \(error)")
        }
        // Every issue is kept, not failed: they are evidence to review
        // against the screenshots, and this is no accessibility pass.
        attach("\(clip) accessibility audit issues (evidence, not a pass)", issues.isEmpty ? "none reported" : issues.joined(separator: "\n"))
        covered("accessibility audit at AX XL text", "\(issues.count) issues listed for review; VoiceOver itself not driven")
        let labels = app.descendants(matching: .any).matching(NSPredicate(format: "label != ''")).allElementsBoundByIndex.prefix(40)
            .map { "\($0.elementType.rawValue) \($0.frame.minY.rounded()) \($0.label.prefix(80))" }
        attach("\(clip) accessibility order", labels.joined(separator: "\n"))

        launchChat("long", clip: "c8-rotation", extra: ["-keyboard"])
        assertReady("open")
        Thread.sleep(forTimeInterval: 1.5)
        step("into history with the keyboard up", quiet: 2.5, expect: .scroll) { fling(older: true, velocity: 1500) }
        let place = number(state()["visibleMinY"])
        screenshot("05-portrait-history-keyboard")
        mark("rotate landscape")
        XCUIDevice.shared.orientation = .landscapeLeft
        Thread.sleep(forTimeInterval: 2.5)
        screenshot("06-landscape")
        attach("\(clip) landscape state", "\(state())")
        mark("rotate portrait")
        XCUIDevice.shared.orientation = .portrait
        Thread.sleep(forTimeInterval: 2.5)
        screenshot("07-portrait-again")
        step("rotations settled", quiet: 0.5) {}
        let after = state()
        attach("\(clip) reading position", "before \(place) after \(after["visibleMinY"] ?? "")")
        XCTAssertEqual(after["displayReady"] as? Bool, true, "rows drawn after rotating")
    }

    // MARK: C9 Composer controls and the voice entry

    private let voiceLabel = "Voice Assistant"

    private func menuElements() -> Int { app.buttons.count + app.menuItems.count }

    /// The composer's chips and its add menu open and close, and the
    /// primary button offers voice when empty and Send with text. Nothing
    /// is chosen: a choice would change the session's modes. Voice isn't
    /// started: it asks for the microphone (a system prompt this suite
    /// never answers), then the server for voice credentials.
    func testC9ComposerControlsAndVoiceEntry() {
        prepare()
        defer { finish() }
        launchChat("markdown", clip: "c9-composer")
        assertReady("open")
        screenshot("01-composer")
        let voice = app.buttons[voiceLabel]
        require("voice entry offered on an empty composer", voice.exists, voice.exists ? "\(voiceLabel) at \(voice.frame)" : "no \(voiceLabel) button")
        notCovered("start and close voice", "starting voice asks for the microphone (a system prompt) and the server for voice credentials")

        for chip in ["MODEL", "PERMISSION MODE", "EFFORT"] {
            let button = app.buttons[chip]
            guard button.exists else {
                notCovered("\(chip) menu", "no \(chip) chip in this fixture's composer")
                continue
            }
            let before = menuElements()
            let frame = button.frame
            step("open \(chip)", quiet: 1.2) { tap(CGPoint(x: frame.midX, y: frame.midY)) }
            let opened = menuElements()
            screenshot("02-\(chip.lowercased().replacingOccurrences(of: " ", with: "-"))-menu")
            guard opened > before else {
                covered("\(chip) menu", "the chip opened no menu (no choices in this fixture): elements \(before) → \(opened)")
                continue
            }
            // Outside the menu, over the header's title: dismisses it
            // without choosing.
            tap(CGPoint(x: size.width / 2, y: 69))
            Thread.sleep(forTimeInterval: 1)
            let closed = menuElements()
            let stayed = (state()["listInWindow"] as? Bool) == true
            require("\(chip) menu opens and closes", closed <= before && stayed, "elements \(before) → \(opened) → \(closed), chat on screen \(stayed)")
            if !stayed {
                back()
                Thread.sleep(forTimeInterval: 1.2)
            }
        }

        let add = app.buttons["Add photo"]
        if add.exists {
            let frame = add.frame
            step("open the add menu", quiet: 1.2) { tap(CGPoint(x: frame.midX, y: frame.midY)) }
            let alert = app.alerts.firstMatch
            let shown = alert.waitForExistence(timeout: 3)
            screenshot("03-add-menu")
            if shown {
                // Never "Paste from Clipboard": that raises the paste prompt.
                alert.buttons["Cancel"].tap()
                Thread.sleep(forTimeInterval: 0.8)
            }
            require("add menu opens and cancels", shown && !app.alerts.firstMatch.exists, shown ? "offered and cancelled" : "no add menu")
        } else {
            notCovered("add menu", "no Add photo button in this fixture's composer")
        }

        let field = app.textViews.firstMatch.frame
        step("focus composer", quiet: 1.5) { tap(CGPoint(x: field.midX, y: field.midY)) }
        app.typeText("Draft")
        Thread.sleep(forTimeInterval: 0.6)
        let sendShown = app.buttons["Send"].exists
        let voiceGone = !app.buttons[voiceLabel].exists
        screenshot("04-send-with-text")
        app.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 5))
        Thread.sleep(forTimeInterval: 0.6)
        let voiceBack = app.buttons[voiceLabel].exists
        screenshot("05-voice-again")
        require("primary button: voice when empty, Send with text", sendShown && voiceGone && voiceBack,
                "Send with text \(sendShown), voice hidden \(voiceGone), voice back once empty \(voiceBack)")
        step("dismiss keyboard", quiet: 1.5) {
            drag(CGPoint(x: size.width / 2, y: size.height * 0.3), CGPoint(x: size.width / 2, y: size.height - 4), velocity: 1500)
        }
        screenshot("06-closed")
    }

    // MARK: R1 The TEST account, read only

    /// Opt in (`TEST_RUNNER_QA_REAL=1`) after staging the recovery secret
    /// into the harness's Documents. Opens the TEST account's newest chat
    /// on UltraList through its real Home, flings it, opens Details, and
    /// reports every request the read-only transport refused. Attaches no
    /// screenshots or text from the account: counts and timings only.
    func testR1RealAccountReadOnly() throws {
        prepare()
        defer { finish() }
        try XCTSkipUnless(ProcessInfo.processInfo.environment["QA_REAL"] == "1", "opt-in: needs the staged TEST secret")
        let app = XCUIApplication()
        app.launchArguments = ["-qaRealChat", "-qaProbe", "-qaRun", "\(pass)-r1-real"]
        launch(app, clip: "r1-real")
        // The account lives only in the app's memory: it ends with the app,
        // whatever way the test ends.
        defer { app.terminate() }
        func real() -> [String: Any] {
            let element = app.otherElements["chat-ultra-qa-real"]
            guard element.exists, let value = element.value as? String,
                  let object = try? JSONSerialization.jsonObject(with: Data(value.utf8)) as? [String: Any] else { return [:] }
            return object
        }
        let ready = wait(120, every: 2) { (real()["phase"] as? String).map { $0 == "ready" || $0.hasPrefix("failed") } ?? false }
        let first = real()
        attach("r1-real phase", "\(first["phase"] ?? "") sessions \(first["sessions"] ?? "")")
        XCTAssertTrue(ready && (first["phase"] as? String) == "ready", "the TEST account signed in and synced")
        guard (first["phase"] as? String) == "ready" else { return }
        XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 20), "Home is up")
        Thread.sleep(forTimeInterval: 3)
        // The TEST account keeps synthetic and empty chats as well: open
        // the chats on Home in turn, up to five, until one draws its
        // messages. Only a chat the server says has no messages, or one
        // deleted or still pending, is passed over (and its reading not
        // covered). A read that fails, a chat still loading after 30 s,
        // rows that never draw or a chat that never opens fail here and
        // stop: never skipped to the next chat.
        let passedOver: Set<String> = ["empty:noMessages", "empty:loadMore", "deleted", "pendingChat"]
        let failed: Set<String> = ["loadFailed", "empty:error"]
        func homeChats() -> [CGRect] {
            (state()["homeChats"] as? [Any] ?? []).compactMap { rect($0) }
                .filter { $0.midY > 130 && $0.midY < size.height - 180 }
        }
        var outcomes: [String] = []
        var drawn = false
        var failure: String?
        var lastChat: Int?
        for index in 0..<5 {
            let chats = homeChats()
            guard index < chats.count else { break }
            let frame = chats[index]
            mark("open Home chat \(index + 1)")
            tap(CGPoint(x: frame.midX, y: frame.midY))
            var rows = 0
            var shown = "none"
            var opened = false
            _ = wait(30, every: 1) {
                let s = state()
                rows = int(s["rows"])
                shown = s["placeholder"] as? String ?? "none"
                opened = opened || (s["listInWindow"] as? Bool) == true || shown != "none"
                drawn = rows > 0 && (s["displayReady"] as? Bool) == true
                return drawn || (rows == 0 && (passedOver.contains(shown) || failed.contains(shown)))
            }
            if drawn {
                outcomes.append("\(index + 1): drawn, rows \(rows)")
                break
            }
            if rows == 0, passedOver.contains(shown) {
                outcomes.append("\(index + 1): \(shown), passed over")
                lastChat = index
                backToHome()
                continue
            }
            failure = !opened ? "the chat never opened in 30 s"
                : rows > 0 ? "\(rows) rows never drew in 30 s"
                : failed.contains(shown) ? "the read failed: \(shown)"
                : "still \(shown == "none" ? "blank" : shown) after 30 s"
            outcomes.append("\(index + 1): FAIL, \(failure ?? "")")
            break
        }
        attach("r1-real chats tried", outcomes.joined(separator: "\n"))
        if let failure {
            // What the read-only transport refused says whether the failure
            // is this harness's (a read that needed a refused request) or
            // the product's; the counts carry no private content.
            let blocked = real()["blocked"] as? [String: Any] ?? [:]
            attach("r1-real read failure", "\(failure); refused requests \(blocked.isEmpty ? "none" : "\(blocked)"); state \(state())")
            XCTFail("real chat \(outcomes.count): \(failure). Refused requests: \(blocked.isEmpty ? "none" : "\(blocked)")")
        } else if drawn {
            assertReady("open")
            for index in 1...2 { step("fling back \(index)", quiet: 2.5, expect: .scroll) { fling(older: true) } }
            step("fling forward", quiet: 2.5, expect: .scroll) { fling(older: false) }
            covered("real chat read, drawn and flung", "chat \(outcomes.count) on Home")
        } else {
            notCovered("real chat with messages", "none among the first \(outcomes.count) chats on Home: \(outcomes.joined(separator: "; "))")
            // Details still opens from a chat without messages.
            guard let lastChat, lastChat < homeChats().count else {
                XCTFail("no chat on Home to open: \(outcomes.joined(separator: "; "))")
                return
            }
            let frame = homeChats()[lastChat]
            mark("open Home chat \(lastChat + 1) again for Details")
            tap(CGPoint(x: frame.midX, y: frame.midY))
            Thread.sleep(forTimeInterval: 4)
        }
        guard (state()["listInWindow"] as? Bool) == true || (state()["placeholder"] as? String ?? "none") != "none" else {
            XCTFail("not in a chat for Details")
            return
        }
        let avatar = app.descendants(matching: .any).allElementsBoundByIndex.prefix(80)
            .first { $0.elementType != .window && $0.frame.width < 70 && $0.frame.width > 30 && $0.frame.midX > size.width * 0.8 && $0.frame.midY < 100 && $0.frame.midY > 40 }
        if let avatar {
            let spot = avatar.frame
            mark("open Details")
            tap(CGPoint(x: spot.midX, y: spot.midY))
            Thread.sleep(forTimeInterval: 3)
            let texts = app.staticTexts.allElementsBoundByIndex.prefix(60).filter { !$0.label.isEmpty }.count
            attach("r1-real details", "\(texts) labelled texts")
            XCTAssertGreaterThanOrEqual(texts, 4, "Details shows its content")
            back()
            Thread.sleep(forTimeInterval: 1.5)
        } else {
            XCTFail("no header avatar to open Details")
        }
        back()
        XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 10), "back on Home")
        attach("r1-real refused requests", "\(real()["blocked"] ?? [:])")
        attach("r1-real openings", "\(state()["opens"] ?? [])")
        attach("r1-real first visual responses", "\(state()["firstVisuals"] ?? [])")
    }

    // MARK: Q0 The question chat on UltraList, opened again and again

    /// Diagnostic: the question fixture on UltraList, alone and after other
    /// chats, recording each opening that never draws.
    func testQ0QuestionChatOpensRepeatedly() {
        prepare()
        defer { finish() }
        var results: [String] = []
        let sequence: [(String, Bool)] = [("question", true), ("question", true), ("question", false), ("question", true),
                                          ("markdown", true), ("question", true), ("tools", true), ("question", true), ("question", true)]
        for (index, (fixture, ultra)) in sequence.enumerated() {
            launchChat(fixture, clip: "q0-\(index)-\(fixture)-\(ultra ? "ultra" : "legacy")", ultra: ultra)
            let ready = wait(12) {
                let s = state()
                return (s["listInWindow"] as? Bool) == true && (s["displayReady"] as? Bool) == true && int(s["rows"]) > 0
            }
            let s = state()
            results.append("\(index) \(fixture) \(ultra ? "ultra" : "legacy"): \(ready ? "drawn" : "NOT DRAWN") rows \(s["rows"] ?? "")")
            if !ready {
                screenshot("not-drawn")
                if let data = try? JSONSerialization.data(withJSONObject: s["ultraNotReady"] ?? [:], options: [.prettyPrinted, .sortedKeys]) {
                    attach("\(clip) UltraList not drawn", String(decoding: data, as: UTF8.self))
                }
                attach("\(clip) state", "\(s)")
            }
        }
        attach("q0 results", results.joined(separator: "\n"))
        XCTAssertFalse(results.contains { $0.contains("NOT DRAWN") }, results.joined(separator: "; "))
    }

    // MARK: Legacy screens for pixel comparison

    func testL2LegacyAndUltraScreens() {
        prepare()
        defer { finish() }
        for fixture in ["markdown", "tools", "question", "sending"] {
            for ultra in [false, true] {
                launchChat(fixture, clip: "l2-\(fixture)-\(ultra ? "ultra" : "legacy")", ultra: ultra)
                assertReady("open", ultra: ultra)
                Thread.sleep(forTimeInterval: fixture == "markdown" ? 2 : 1)
                screenshot("newest")
                step("held drag back", quiet: 1.5, expect: .scroll) { move(older: true, by: size.height * 0.5) }
                screenshot("history")
            }
        }
    }
}
