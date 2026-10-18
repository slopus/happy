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
/// `QA_PASS` (from `TEST_RUNNER_QA_PASS`) prefixes the probe's file names,
/// so a recorded pass and an unrecorded timing pass keep separate files.
final class ChatUltraQATests: XCTestCase {
    private var app: XCUIApplication!
    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    private var steps: [[String: Any]] = []
    private var clip = ""
    private var size = CGSize(width: 390, height: 844)
    /// Windows already attributed to a step in the current launch.
    private var known = 0
    private var touchedLast = false
    private static var aimThroughSpringboard = true

    override func setUp() {
        super.setUp()
        continueAfterFailure = true
        _ = skipsQuiescence
        // Ahead of XCTest's own handler, which would tap a default button.
        addUIInterruptionMonitor(withDescription: "Fail on any system alert") { [weak self] alert in
            self?.continueAfterFailure = false
            XCTFail("A system alert appeared and was left unanswered: \(alert.label)")
            return true
        }
    }

    override func tearDown() {
        flushSteps()
        XCUIDevice.shared.orientation = .portrait
        super.tearDown()
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

    private func launchHome(clip: String, renderer: String = "UITableView", ultra: Bool = true) {
        let app = XCUIApplication()
        app.launchArguments = ["-screen", "home", "-renderer", renderer, "-grouping", "flat", "-sessionCount", "0", "-archiveCount", "0",
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
    ]

    private func compact(_ window: [String: Any]) -> [String: Any] {
        window.filter { Self.windowKeys.contains($0.key) }
    }

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
        action()
        Thread.sleep(forTimeInterval: quiet)
        let closed = wait(requireWindow ? 15 : 4, every: 1) {
            let s = state()
            return int(s["windowCount"]) > before && (s["moving"] as? Bool) == false
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
        let root: XCUIElement = Self.aimThroughSpringboard && XCUIDevice.shared.orientation == .portrait ? springboard : app
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
    private func find(_ what: String, moves: Int = 8, older: Bool = true, hold: Bool? = nil, _ predicate: (Hit) -> Bool) -> Hit? {
        for attempt in 0...moves {
            let report = controls()
            if let hit = hits(report, hold: hold).first(where: { predicate($0) && reachable($0.frame, in: report) }) { return hit }
            guard attempt < moves else { break }
            step("seek \(what) \(attempt + 1)", quiet: 1.2, expect: .scroll) { move(older: older, by: size.height * 0.35) }
        }
        attach("\(clip) not found", what)
        return nil
    }

    private func natives(_ report: [String: Any]) -> [[String: Any]] {
        report["native"] as? [[String: Any]] ?? []
    }

    private func newest(_ prefix: String) -> Hit? {
        let report = controls()
        return hits(report).filter { $0.action.hasPrefix(prefix) && reachable($0.frame, in: report) }.max { $0.frame.minY < $1.frame.minY }
    }

    // MARK: Smoke

    /// Device, signing and capture: the long chat on UltraList, a fling
    /// back and one forward.
    func testSmokeLongFling() {
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
        runLong(ultra: true, clip: "c1-long")
    }

    /// The same clip on the default renderer, for comparison.
    func testL1LegacyLongKeyboardAndHistory() {
        runLong(ultra: false, clip: "l1-legacy-long")
    }

    private func runLong(ultra: Bool, clip: String) {
        launchChat("long", clip: clip, ultra: ultra, extra: ["-keyboard"])
        assertReady("open", ultra: ultra)
        let keyboardUp = wait(10) { number(scrollProbe()["keyboardTop"]) < size.height - 150 }
        Thread.sleep(forTimeInterval: 1)
        step("keyboard shown", quiet: 0.5, requireWindow: false) {}
        screenshot("01-keyboard-up")
        XCTAssertTrue(keyboardUp, "the composer took focus and the keyboard came up")

        step("type three lines", quiet: 1.5, requireWindow: false) { app.typeText("A longer note for the agent\nwith a second line\nand a third one") }
        screenshot("02-composer-three-lines")

        var probe = scrollProbe()
        let dockTop = number(probe["dockMinY"])
        let keyboardTop = number(probe["keyboardTop"])
        let x = size.width / 2
        step("partial dismiss released", quiet: 2) {
            drag(CGPoint(x: x, y: dockTop - 110), CGPoint(x: x, y: keyboardTop + (size.height - keyboardTop) * 0.35), velocity: 300, hold: 0.4)
        }
        probe = scrollProbe()
        attach("\(clip) partial dismiss touch", "\(probe["lastTouch"] ?? [:]) keyboardTop \(probe["keyboardTop"] ?? "")")
        screenshot("03-after-partial-dismiss")

        let dockNow = number(probe["dockMinY"])
        step("interactive dismiss", quiet: 2) {
            drag(CGPoint(x: x, y: dockNow - 110), CGPoint(x: x, y: size.height - 4), velocity: 250, hold: 0.3)
        }
        probe = scrollProbe()
        let touch = probe["lastTouch"] as? [String: Any] ?? [:]
        attach("\(clip) dismiss touch", "\(touch)")
        let finger = number(touch["fingerTravelWithKeyboard"]), content = number(touch["offsetTravelWithKeyboard"])
        if finger > 80 {
            XCTAssertEqual(content / finger, 1, accuracy: 0.15, "content \(content) for a finger's \(finger) while the keyboard moved")
        } else {
            XCTFail("the keyboard did not follow the finger far enough to measure (finger \(finger) with the keyboard moving)")
        }
        screenshot("04-keyboard-dismissed")

        step("pull past newest", quiet: 2, expect: .scroll) {
            drag(CGPoint(x: x, y: size.height * 0.62), CGPoint(x: x, y: size.height * 0.38), velocity: 500)
        }
        XCTAssertEqual(number(state()["visibleMinY"]), 0, accuracy: 1, "sprang back to the newest message")

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
        } else {
            XCTFail("no jump-to-newest button deep in the history")
        }
        XCTAssertEqual(number(state()["visibleMinY"]), 0, accuracy: 1, "back at the newest message")
        screenshot("07-back-at-newest")
    }

    // MARK: C2 Streaming

    func testC2LiveStreamHistoryAndSend() {
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
        step("stream ends away from newest", quiet: 0.5, expect: .away, requireWindow: false) {}
        assertReady("after stream")
        screenshot("04-after-stream-in-history")

        if app.buttons["Scroll to bottom"].exists {
            let frame = app.buttons["Scroll to bottom"].frame
            step("jump to newest", quiet: 2) { tap(CGPoint(x: frame.midX, y: frame.midY)) }
        }
        screenshot("05-finished-reply")

        let composer = app.textViews.firstMatch
        let field = composer.frame
        step("focus composer", quiet: 1.5) { tap(CGPoint(x: field.midX, y: field.midY)) }
        app.typeText("Walk me through the anchor with the keyboard up")
        let send = app.buttons["Send"]
        XCTAssertTrue(send.exists, "a Send button")
        let sendFrame = send.frame
        mark("send")
        tap(CGPoint(x: sendFrame.midX, y: sendFrame.midY))
        Thread.sleep(forTimeInterval: 2.4)
        screenshot("06-sent-tool-running")
        Thread.sleep(forTimeInterval: 5)
        step("reply streamed at newest with the keyboard up", quiet: 0.5, requireWindow: false) {}
        screenshot("07-reply-with-keyboard")

        step("dismiss keyboard", quiet: 2) {
            drag(CGPoint(x: size.width / 2, y: size.height * 0.3), CGPoint(x: size.width / 2, y: size.height - 4), velocity: 1500)
        }
        if let copy = newest("copy:") {
            mark("copy the newest reply")
            tap(copy.center)
            Thread.sleep(forTimeInterval: 0.3)
            screenshot("08-copy-tick")
            Thread.sleep(forTimeInterval: 1.8)
            screenshot("09-copy-reset")
            step("copy settles", quiet: 0.3, requireWindow: false) {}
        } else {
            XCTFail("no copy button on the newest reply")
        }
    }

    // MARK: C3 Tools and permissions

    func testC3ToolsPermissionsDiffs() {
        launchChat("tools", clip: "c3-tools")
        assertReady("open")
        screenshot("01-newest-pending-permissions")

        if let allow = find("allow perm-edit", moves: 3, { $0.action == "permission:perm-edit:allow" }) {
            step("allow the edit", quiet: 1.5, expect: .pin) { tap(allow.center) }
            screenshot("02-edit-allowed")
        }
        if let deny = find("deny perm-bash", moves: 3, older: false, { $0.action == "permission:perm-bash:deny" }) {
            step("deny the bash", quiet: 1.5, expect: .pin) { tap(deny.center) }
            screenshot("03-bash-denied")
        }
        var report = controls()
        let vertical = natives(report).first { ($0["k"] as? String) == "scroller" && ($0["vertical"] as? Bool) == true }
        if let vertical, let frame = rect(vertical["f"]), let content = vertical["content"] as? [NSNumber],
           content.count == 2, CGFloat(content[1].doubleValue) > frame.height + 4 {
            step("scroll a permission list", quiet: 1.5) {
                drag(CGPoint(x: frame.midX, y: frame.maxY - 10), CGPoint(x: frame.midX, y: frame.minY + 10), velocity: 600, hold: 0.2)
            }
            attach("\(clip) permission list", "before \(vertical["offset"] ?? "") after \(natives(controls()).filter { ($0["row"] as? String) == (vertical["row"] as? String) })")
            screenshot("04-permission-list-scrolled")
        } else {
            attach("\(clip) vertical", "no permission list taller than its box on screen")
        }

        if let group = find("a tool group", moves: 10, { $0.action.hasPrefix("group:") }) {
            step("open a group", quiet: 1.5, expect: .pin) { tap(group.center) }
            screenshot("05-group-open")
        }
        if let tool = find("an expandable tool", moves: 6, { $0.action.hasPrefix("tool:") }) {
            step("open a tool mid-history", quiet: 1.5, expect: .pin) { tap(tool.center) }
            screenshot("06-tool-open")
            report = controls()
            if let same = hits(report).first(where: { $0.action == tool.action && reachable($0.frame, in: report) }) {
                step("close the tool", quiet: 1.5, expect: .pin) { tap(same.center) }
                screenshot("07-tool-closed")
            }
        }
        report = controls()
        if let showMore = natives(report).first(where: { ($0["k"] as? String) == "showMore" }).flatMap({ rect($0["f"]) }), reachable(showMore, in: report) {
            step("show more diff lines", quiet: 1.5) { tap(CGPoint(x: showMore.midX, y: showMore.midY)) }
            screenshot("08-diff-show-more")
        } else {
            attach("\(clip) show more", "no Show more bar on screen")
        }
        report = controls()
        let horizontal = natives(report).first { ($0["k"] as? String) == "scroller" && ($0["vertical"] as? Bool) == false && rect($0["f"]).map { reachable($0, in: report) } == true }
        if let horizontal, let frame = rect(horizontal["f"]) {
            step("pan a strip sideways", quiet: 1.5) {
                drag(CGPoint(x: frame.maxX - 20, y: frame.midY), CGPoint(x: frame.minX + 20, y: frame.midY), velocity: 600, hold: 0.2)
            }
            let after = natives(controls()).first { ($0["row"] as? String) == (horizontal["row"] as? String) && ($0["k"] as? String) == "scroller" }
            attach("\(clip) sideways", "before \(horizontal["offset"] ?? "") after \(after?["offset"] ?? "")")
            screenshot("09-strip-panned")
        } else {
            attach("\(clip) sideways", "no sideways strip on screen")
        }
        step("fling back", quiet: 2.5, expect: .scroll) { fling(older: true) }
        step("catch momentum and pan sideways", quiet: 2) {
            fling(older: false, velocity: 1800)
            drag(CGPoint(x: size.width * 0.8, y: size.height * 0.45), CGPoint(x: size.width * 0.2, y: size.height * 0.45), velocity: 800, hold: 0.1)
        }
        screenshot("10-after-catch")
    }

    // MARK: C4 Markdown, links, copy, pictures

    func testC4MarkdownLinksCopyPictures() {
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
            step("copy settles", quiet: 0.3, requireWindow: false) {}
        }
        if let held = find("a long-press target", moves: 3, hold: true, { $0.action == "markdownSelectable" || $0.action == "copyMenu" }) {
            step("long press \(held.action)", quiet: 1.2, requireWindow: false) { hold(held.center) }
            screenshot("04-long-press-menu")
            let copy = app.descendants(matching: .any)["Copy"].firstMatch
            if copy.exists {
                copy.tap()
            } else {
                tap(CGPoint(x: size.width / 2, y: 150))
            }
            Thread.sleep(forTimeInterval: 1)
            screenshot("05-menu-closed")
            if (state()["listInWindow"] as? Bool) == false {
                // Markdown Copy v2 opens the text selection screen.
                back()
                Thread.sleep(forTimeInterval: 1.2)
            }
        }
        if let option = find("an option", moves: 4, { $0.action.hasPrefix("option:") }) {
            screenshot("06-options")
            mark("choose \(option.action)")
            tap(option.center)
            Thread.sleep(forTimeInterval: 1.5)
            screenshot("07-option-sent")
            Thread.sleep(forTimeInterval: 5)
            screenshot("08-option-reply")
            step("option reply settles", quiet: 0.5, requireWindow: false) {}
        }

        if let picture = find("a picture", moves: 6, { $0.action.hasPrefix("open:") || $0.action.hasPrefix("openFile:") || $0.action.hasPrefix("file:") }) {
            screenshot("09-pictures")
            step("open \(picture.action)", quiet: 1.5, requireWindow: false) { tap(picture.center) }
            screenshot("10-opened-screen")
            if (state()["listInWindow"] as? Bool) == false {
                back()
                XCTAssertTrue(wait(5) { (state()["listInWindow"] as? Bool) == true }, "back in the chat")
            }
            screenshot("11-back-in-chat")
        }
        var panned = false
        for index in 1...5 where !panned {
            let report = controls()
            if let strip = natives(report).first(where: { ($0["k"] as? String) == "scroller" && ($0["vertical"] as? Bool) == false && rect($0["f"]).map { reachable($0, in: report) } == true }),
               let frame = rect(strip["f"]) {
                step("pan code or table sideways", quiet: 1.5) {
                    drag(CGPoint(x: frame.maxX - 20, y: frame.midY), CGPoint(x: frame.minX + 30, y: frame.midY), velocity: 700, hold: 0.2)
                }
                attach("\(clip) strip", "before \(strip["offset"] ?? "") after \(natives(controls()).filter { ($0["row"] as? String) == (strip["row"] as? String) })")
                screenshot("12-strip-panned")
                panned = true
            } else {
                step("seek a strip \(index)", quiet: 1.2, expect: .scroll) { move(older: true, by: size.height * 0.35) }
            }
        }
        step("fling away", quiet: 2.5, expect: .scroll) { fling(older: false) }
        step("fling back", quiet: 2.5, expect: .scroll) { fling(older: true) }
        screenshot("13-after-reuse")
        for index in 1...4 {
            let report = controls()
            if let link = (report["links"] as? [[String: Any]])?.first(where: {
                guard let point = $0["p"] as? [NSNumber], point.count == 2 else { return false }
                return reachable(CGRect(x: point[0].doubleValue - 5, y: point[1].doubleValue - 5, width: 10, height: 10), in: report)
            }), let point = link["p"] as? [NSNumber] {
                mark("link \(link["url"] ?? "")")
                tap(CGPoint(x: point[0].doubleValue, y: point[1].doubleValue))
                let left = app.wait(for: .runningBackground, timeout: 6)
                XCTAssertTrue(left, "a link opens outside the app")
                screenshot("14-link-opened")
                app.activate()
                Thread.sleep(forTimeInterval: 1.5)
                screenshot("15-returned")
                break
            }
            step("seek a link \(index)", quiet: 1.2, expect: .scroll) { move(older: true, by: size.height * 0.35) }
        }
    }

    // MARK: C5 Questions and sending

    func testC5QuestionsAndSending() {
        launchChat("question", clip: "c5-question")
        assertReady("open")
        screenshot("01-question")
        if let first = find("an inline question option", moves: 3, { $0.action.hasPrefix("question:") }) {
            step("choose an inline option", quiet: 1, requireWindow: false) { tap(first.center) }
            let report = controls()
            if let second = hits(report).first(where: { $0.action.hasPrefix("question:") && $0.action.hasSuffix(":2") && reachable($0.frame, in: report) }) {
                step("choose another option", quiet: 1, requireWindow: false) { tap(second.center) }
            }
            screenshot("02-inline-chosen")
            let after = controls()
            if let submit = hits(after).first(where: { $0.action.hasPrefix("submit:") && reachable($0.frame, in: after) }) {
                step("submit inline answers", quiet: 1.5, requireWindow: false) { tap(submit.center) }
                screenshot("03-inline-submitted")
            } else {
                XCTFail("no enabled submit for the inline question")
            }
        }
        let banner = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Platform")).firstMatch
        if banner.exists {
            banner.tap()
            Thread.sleep(forTimeInterval: 1.2)
            screenshot("04-question-sheet")
            for label in ["iPhone", "iPad"] {
                let option = app.descendants(matching: .any)[label].firstMatch
                if option.exists { option.tap() }
            }
            let own = app.textViews.matching(NSPredicate(format: "placeholderValue == %@ OR label == %@", "Write an answer instead", "Write an answer instead")).firstMatch
            if own.exists {
                own.tap()
                app.typeText("Also the iPad mini")
            }
            Thread.sleep(forTimeInterval: 0.8)
            screenshot("05-sheet-answer-above-keyboard")
            let submit = app.buttons["Send answer"]
            XCTAssertTrue(submit.exists, "the sheet's Send answer")
            if submit.exists { submit.tap() }
            Thread.sleep(forTimeInterval: 1.5)
            screenshot("06-sheet-sent")
        } else {
            XCTFail("no question banner in the dock")
        }

        launchChat("sending", clip: "c5-sending")
        assertReady("open")
        screenshot("07-pending-and-refused")
        let field = app.textViews.firstMatch.frame
        tap(CGPoint(x: field.midX, y: field.midY))
        Thread.sleep(forTimeInterval: 1)
        app.typeText("This one should fail first")
        let send = app.buttons["Send"].frame
        step("send a message that fails", quiet: 2.5, requireWindow: false) { tap(CGPoint(x: send.midX, y: send.midY)) }
        screenshot("08-failed")
        step("dismiss keyboard", quiet: 1.5, requireWindow: false) {
            drag(CGPoint(x: size.width / 2, y: size.height * 0.3), CGPoint(x: size.width / 2, y: size.height - 4), velocity: 1500)
        }
        if let retry = find("retry", moves: 2, { $0.action.hasPrefix("retry:local-") }) {
            step("retry", quiet: 3, requireWindow: false) { tap(retry.center) }
            screenshot("09-retried")
            Thread.sleep(forTimeInterval: 5)
            screenshot("10-reply")
            step("reply settles", quiet: 0.5, requireWindow: false) {}
        } else {
            XCTFail("no retry on the failed message")
        }
    }

    // MARK: C6 Diagrams and one giant message

    func testC6DiagramsAndGiantMessage() {
        launchChat("diagrams", clip: "c6-diagrams")
        assertReady("open")
        Thread.sleep(forTimeInterval: 3)
        step("diagrams measured", quiet: 0.5, requireWindow: false) {}
        screenshot("01-diagrams")
        func webViews() -> [String] { natives(controls()).filter { ($0["k"] as? String) == "webView" }.compactMap { $0["object"] as? String } }
        let first = webViews()
        for index in 1...3 {
            step("through the diagrams \(index)", quiet: 1.5, expect: .scroll) { move(older: true, by: size.height * 0.4) }
            screenshot("02-diagrams-\(index)")
        }
        let report = controls()
        if let mermaid = natives(report).compactMap({ ($0["k"] as? String) == "mermaid" ? rect($0["f"]) : nil }).max(by: { $0.height < $1.height }), mermaid.height > 160 {
            let top = max(mermaid.minY, 160) + 20, bottom = min(mermaid.maxY, size.height - 200) - 20
            if bottom - top > 80 {
                step("drag inside a diagram", quiet: 1.5) {
                    drag(CGPoint(x: mermaid.midX, y: bottom), CGPoint(x: mermaid.midX, y: top), velocity: 600, hold: 0.2)
                }
                screenshot("03-inside-diagram")
            }
        }
        step("back to newest", quiet: 2, expect: .scroll) { fling(older: false) }
        let again = webViews()
        attach("\(clip) web views", "first \(first) after \(again)")
        XCTAssertFalse(first.isEmpty, "diagrams drew in WebKit")

        launchChat("giant", clip: "c6-giant-350", extra: ["-giantParagraphs", "350"])
        assertReady("open")
        let rows = controls()["rows"] as? [[String: Any]] ?? []
        attach("\(clip) rows", "\(rows)")
        screenshot("04-giant-newest")
        for index in 1...4 { step("fling through giant \(index)", quiet: 2.5, expect: .scroll) { fling(older: true, velocity: 4000) } }
        screenshot("05-giant-deep")
        for index in 1...2 { step("fling back \(index)", quiet: 2.5, expect: .scroll) { fling(older: false, velocity: 4000) } }
        screenshot("06-giant-after")

        // Rows either side of the 4096-point line where drawing moves from
        // tiles to the native canvas.
        launchChat("giant", clip: "c6-giant-40", extra: ["-giantParagraphs", "40"])
        assertReady("open")
        let tallest = (controls()["rows"] as? [[String: Any]] ?? []).compactMap { ($0["h"] as? NSNumber)?.doubleValue }.max() ?? 0
        let perParagraph = max(20, tallest / 40)
        for target in [3950.0, 4250.0] {
            let count = max(1, Int((target / perParagraph).rounded()))
            launchChat("giant", clip: "c6-giant-\(count)", extra: ["-giantParagraphs", "\(count)"])
            assertReady("open")
            let row = (controls()["rows"] as? [[String: Any]] ?? []).max { (($0["h"] as? NSNumber)?.doubleValue ?? 0) < (($1["h"] as? NSNumber)?.doubleValue ?? 0) }
            attach("\(clip) near-threshold row", "\(row ?? [:])")
            screenshot("07-near-threshold")
            for index in 1...2 { step("fling \(index)", quiet: 2.5, expect: .scroll) { fling(older: true, velocity: 3500) } }
            step("fling forward", quiet: 2.5, expect: .scroll) { fling(older: false, velocity: 3500) }
            screenshot("08-near-threshold-after")
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
                    let avatar = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", title)).allElementsBoundByIndex
                        .first { $0.frame.midX > size.width * 0.75 && $0.frame.midY < 140 }
                    if let avatar {
                        let spot = avatar.frame
                        tap(CGPoint(x: spot.midX, y: spot.midY))
                        Thread.sleep(forTimeInterval: 1.5)
                        screenshot("details")
                        let texts = app.staticTexts.allElementsBoundByIndex.prefix(40).map(\.label).filter { !$0.isEmpty }
                        attach("\(clip) details texts", "\(texts)")
                        XCTAssertGreaterThanOrEqual(texts.count, 4, "Details shows its content")
                        back()
                        Thread.sleep(forTimeInterval: 1.2)
                    } else {
                        XCTFail("no header avatar to open Details")
                    }
                }
                backToHome()
            }
        }
        let opens = state()["opens"] as? [[String: Any]] ?? []
        attach("\(clip) openings", "\(opens)")
        XCTAssertEqual(opens.count, 4, "every opening reached a drawn chat")

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
    }

    // MARK: C8 Appearance, text size, rotation, accessibility

    func testC8DarkLargeTextRotationAccessibility() {
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
        attach("\(clip) accessibility audit", issues.isEmpty ? "no issues" : issues.joined(separator: "\n"))
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
        step("rotations settled", quiet: 0.5, requireWindow: false) {}
        let after = state()
        attach("\(clip) reading position", "before \(place) after \(after["visibleMinY"] ?? "")")
        XCTAssertEqual(after["displayReady"] as? Bool, true, "rows drawn after rotating")
    }

    // MARK: R1 The TEST account, read only

    /// Opt in (`TEST_RUNNER_QA_REAL=1`) after staging the recovery secret
    /// into the harness's Documents. Opens the TEST account's newest chat
    /// on UltraList through its real Home, flings it, opens Details, and
    /// reports every request the read-only transport refused. Attaches no
    /// screenshots or text from the account: counts and timings only.
    func testR1RealAccountReadOnly() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["QA_REAL"] == "1", "opt-in: needs the staged TEST secret")
        let app = XCUIApplication()
        app.launchArguments = ["-qaRealChat", "-qaProbe", "-qaRun", "\(pass)-r1-real"]
        launch(app, clip: "r1-real")
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
        let cell = app.cells.firstMatch
        XCTAssertTrue(cell.waitForExistence(timeout: 20), "a chat on Home")
        let frame = cell.frame
        mark("open newest chat")
        tap(CGPoint(x: frame.midX, y: frame.midY))
        Thread.sleep(forTimeInterval: 4)
        assertReady("open")
        for index in 1...2 { step("fling back \(index)", quiet: 2.5, expect: .scroll) { fling(older: true) } }
        step("fling forward", quiet: 2.5, expect: .scroll) { fling(older: false) }
        let avatar = app.descendants(matching: .any).allElementsBoundByIndex.prefix(80)
            .first { $0.elementType != .window && $0.frame.width < 70 && $0.frame.width > 30 && $0.frame.midX > size.width * 0.8 && $0.frame.midY < 140 && $0.frame.midY > 40 }
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
    }

    // MARK: Legacy screens for pixel comparison

    func testL2LegacyAndUltraScreens() {
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
