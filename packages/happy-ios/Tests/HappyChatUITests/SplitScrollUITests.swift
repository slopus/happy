import XCTest

/// Scrolling in the iPad's main panel, in the app's own split view
/// (`-screen split`): every drag moves the agent's chat by the finger's
/// distance, again and again, after a fling too, with the sidebar shown
/// and hidden; Settings' page the same. The probe (`ChatScrollProbe`)
/// says what each finger did to the chat and which recognizers it
/// reached, window to list, and none may cancel the list's pan.
final class SplitScrollUITests: XCTestCase {
    override func setUp() {
        // The system's glass never lets the app idle: act without waiting.
        _ = skipsQuiescence
        continueAfterFailure = true
        XCUIDevice.shared.orientation = .portrait
    }

    private func launch(_ arguments: [String]) throws -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-screen", "split", "-agent", "-long", "-open", "ipad-agent", "-probe"] + arguments
        app.launch()
        let probe = app.otherElements["chat-scroll-probe"]
        XCTAssertTrue(probe.waitForExistence(timeout: 30), "no probe: the chat never opened")
        if app.windows.firstMatch.frame.width < 768 { throw XCTSkip("an iPad's split view") }
        _ = state(app, timeout: 20) { ($0["rows"] as? NSNumber)?.intValue ?? 0 > 20 }
        return app
    }

    private func read(_ app: XCUIApplication) -> [String: Any] {
        let element = app.otherElements["chat-scroll-probe"]
        guard element.exists, let value = element.value as? String,
              let object = try? JSONSerialization.jsonObject(with: Data(value.utf8)) as? [String: Any] else { return [:] }
        return object
    }

    private func state(_ app: XCUIApplication, timeout: TimeInterval = 5, until condition: ([String: Any]) -> Bool) -> [String: Any] {
        let deadline = Date().addingTimeInterval(timeout)
        var last = read(app)
        while !condition(last), Date() < deadline {
            Thread.sleep(forTimeInterval: 0.1)
            last = read(app)
        }
        return last
    }

    private func touch(_ state: [String: Any]) -> [String: Any] { state["lastTouch"] as? [String: Any] ?? [:] }
    private func index(_ state: [String: Any]) -> Int { (touch(state)["index"] as? NSNumber)?.intValue ?? 0 }
    private func number(_ value: Any?) -> CGFloat { CGFloat((value as? NSNumber)?.doubleValue ?? .nan) }

    private func point(_ app: XCUIApplication, _ x: CGFloat, _ y: CGFloat) -> XCUICoordinate {
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y))
    }

    /// A drag held still at its end, so nothing glides: the list must have
    /// gone the finger's way and distance.
    private func assertDragFollows(_ app: XCUIApplication, from: CGFloat, to: CGFloat, _ label: String) {
        let before = index(read(app))
        let window = app.windows.firstMatch.frame
        let x = window.maxX - 240
        point(app, x, from).press(forDuration: 0.05, thenDragTo: point(app, x, to), withVelocity: 300, thenHoldForDuration: 0.3)
        let after = state(app) { self.index($0) > before }
        let finger = number(touch(after)["fingerTravel"])
        let content = number(touch(after)["offsetTravel"])
        let path = (touch(after)["path"] as? [String]) ?? []
        let place = "at \(number(after["visibleMinY"])) of \(number(after["maxDistance"]))"
        let detail = "\(label): finger \(finger), list \(content), \(place), path \(path)"
        print("SPLIT-SCROLL \(detail)")
        XCTAssertGreaterThan(index(after), before, "\(label): the probe saw no touch")
        // The list's own pan, never cancelled under the finger.
        XCTAssertTrue((touch(after)["recognizers"] as? [String] ?? []).contains("UltraList.InputPan"), detail)
        XCTAssertFalse(path.contains { $0.contains("InputPan") && $0.contains("cancelled") }, detail)
        // A finger landing on a glide stops it: the list runs on only to
        // the frame the screen already had in hand, a few points, then
        // holds still until the finger moves.
        let caught = number(touch(after)["catchTravel"])
        print("SPLIT-SCROLL \(label): caught after \(caught), from landing \(number(touch(after)["offsetTravelFromLanding"]))")
        XCTAssertLessThanOrEqual(abs(caught), 40, "\(label): the glide ran on under the finger, \(caught)")
        if (touch(after)["restingSamples"] as? NSNumber)?.intValue ?? 0 > 1 {
            XCTAssertLessThanOrEqual(number(touch(after)["restingDrift"]), 0.5, "\(label): the caught list moved under a resting finger")
        }
        // The content moves by as much as the finger, less the touch's
        // slop before the pan began, from where the finger caught it. A
        // drag that caught the list past an end, rubber-banding after a
        // fling, rightly gives less: where it started says so.
        let start = number(after["visibleMinY"]) - content
        guard start >= -1, start <= number(after["maxDistance"]) + 1 else {
            print("SPLIT-SCROLL \(label) began past an end, at \(start)")
            return
        }
        XCTAssertEqual(abs(content), abs(finger), accuracy: 24, detail)
    }

    private func drags(_ app: XCUIApplication, _ name: String) {
        let height = app.windows.firstMatch.frame.height
        for round in 0..<2 {
            assertDragFollows(app, from: height * 0.35, to: height * 0.65, "\(name) back \(round)")
            assertDragFollows(app, from: height * 0.65, to: height * 0.4, "\(name) forward \(round)")
        }
        // A fling, then a drag while it glides, the other way. Away from
        // the ends: a drag that lands while the list rubber-bands past one
        // rightly gives less than the finger.
        let x = app.windows.firstMatch.frame.maxX - 240
        func fling(back: Bool) {
            let (from, to) = back ? (0.3, 0.75) : (0.75, 0.3)
            point(app, x, height * from).press(forDuration: 0.02, thenDragTo: point(app, x, height * to), withVelocity: 3000, thenHoldForDuration: 0)
        }
        fling(back: true)
        assertDragFollows(app, from: height * 0.65, to: height * 0.4, "\(name) forward after a fling back 0")
        fling(back: true)
        assertDragFollows(app, from: height * 0.65, to: height * 0.4, "\(name) forward after a fling back 1")
        fling(back: false)
        assertDragFollows(app, from: height * 0.4, to: height * 0.65, "\(name) back after a fling forward")
    }

    func testDragsFollowTheFingerBesideTheSidebar() throws {
        let app = try launch([])
        drags(app, "sidebar")
    }

    func testDragsFollowTheFingerWithTheSidebarHidden() throws {
        let app = try launch(["-hideSidebar"])
        sleep(1)
        drags(app, "hidden")
    }

    /// A row of `app` under `x`, inside the window's middle band.
    private func row(_ app: XCUIApplication, near x: ClosedRange<CGFloat>) throws -> XCUIElement {
        let height = app.windows.firstMatch.frame.height
        let rows = app.descendants(matching: .any).allElementsBoundByIndex.filter {
            !$0.label.isEmpty && $0.frame.height > 20 && $0.frame.height < 120
                && x.contains($0.frame.midX) && $0.frame.minY > height * 0.3 && $0.frame.maxY < height * 0.7
        }
        return try XCTUnwrap(rows.first, "no row there")
    }

    /// Short drags up and down, held at their ends: a row moves with the
    /// finger each time. Short, so a short page never reaches its end.
    private func assertRowsFollow(_ app: XCUIApplication, x: CGFloat, column: ClosedRange<CGFloat>, _ name: String) throws {
        let height = app.windows.firstMatch.frame.height
        for (round, (from, to)) in [(0.6, 0.54), (0.54, 0.6), (0.6, 0.54), (0.54, 0.6)].enumerated() {
            // Found again by its label after the drag: one bound by its
            // index can be another element by then.
            let label = try row(app, near: column).label
            let row = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
            let before = row.frame.minY
            point(app, x, height * from).press(forDuration: 0.05, thenDragTo: point(app, x, height * to), withVelocity: 300, thenHoldForDuration: 0.3)
            sleep(1)
            let finger = height * (to - from)
            let moved = row.frame.minY - before
            print("SPLIT-SCROLL \(name) \(round): finger \(finger), row \(moved) (\(label.prefix(30)))")
            XCTAssertEqual(moved, finger, accuracy: 24, "\(name) \(round): the page didn't follow the finger")
        }
    }

    private func page(_ app: XCUIApplication) -> [String: Any] {
        let element = app.otherElements["page-scroll-probe"]
        guard element.exists, let value = element.value as? String,
              let object = try? JSONSerialization.jsonObject(with: Data(value.utf8)) as? [String: Any] else { return [:] }
        return object
    }

    /// Settings in the main panel, held to the readable column by its
    /// scroll view's insets: each drag moves the page by the finger, a
    /// fling then a drag too, and nothing but the finger and the glide
    /// ever moves it or changes its insets.
    func testSettingsFollowsTheFinger() throws {
        let app = XCUIApplication()
        // A Happy CLI account's, which scrolls on either iPad.
        app.launchArguments = ["-screen", "split", "-settings", "-pageProbe"]
        app.launch()
        XCTAssertTrue(app.otherElements["page-scroll-probe"].waitForExistence(timeout: 30))
        let window = app.windows.firstMatch
        if window.frame.width < 768 { throw XCTSkip("an iPad's split view") }
        sleep(1)
        let start = page(app)
        let x = window.frame.maxX - 240
        let height = window.frame.height
        let room = number(start["maxOffsetY"])
        XCTAssertGreaterThan(room, 60, "Settings doesn't scroll: \(start)")
        // Drags inside what it scrolls, so no end gives less.
        let reach = min(height * 0.25, room * 0.8)
        for round in 0..<3 {
            for (from, to) in [(height * 0.7, height * 0.7 - reach), (height * 0.7 - reach, height * 0.7)] {
                let before = number(page(app)["offsetY"])
                point(app, x, from).press(forDuration: 0.05, thenDragTo: point(app, x, to), withVelocity: 300, thenHoldForDuration: 0.3)
                sleep(1)
                let after = page(app)
                let moved = number(after["offsetY"]) - before
                print("SPLIT-SCROLL settings \(round): finger \(to - from), page \(-moved), \(after)")
                XCTAssertEqual(-moved, to - from, accuracy: 24, "settings \(round): \(after)")
            }
        }
        // A fling to the end and back, then a drag.
        point(app, x, height * 0.8).press(forDuration: 0.02, thenDragTo: point(app, x, height * 0.3), withVelocity: 3000, thenHoldForDuration: 0)
        point(app, x, height * 0.3).press(forDuration: 0.02, thenDragTo: point(app, x, height * 0.8), withVelocity: 3000, thenHoldForDuration: 0)
        sleep(2)
        let end = page(app)
        print("SPLIT-SCROLL settings at rest: \(end)")
        XCTAssertEqual(number(end["offsetY"]), 0, accuracy: 1, "back at the top")
        XCTAssertEqual(number(end["offsetX"]), 0, accuracy: 0.5, "the page moved sideways")
        XCTAssertEqual((end["foreignOffsets"] as? NSNumber)?.intValue, (start["foreignOffsets"] as? NSNumber)?.intValue, "something else moved the page: \(end)")
        XCTAssertEqual((end["insetChanges"] as? NSNumber)?.intValue, (start["insetChanges"] as? NSNumber)?.intValue, "the insets changed under the finger: \(end)")
    }

    /// Home's list in the sidebar, forty sessions long.
    func testTheSidebarsListFollowsTheFinger() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-screen", "home", "-sessionCount", "40"]
        app.launch()
        let window = app.windows.firstMatch
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        if window.frame.width < 768 { throw XCTSkip("an iPad's split view") }
        sleep(4)
        try assertRowsFollow(app, x: 170, column: 0...330, "sidebar list")
    }
}
