import XCTest

final class HomeRendererUITests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false; _ = skipsQuiescence }

    private func launch(_ renderer: String, grouping: String = "flat", count: Int = 0, archives: Int = 0) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-screen", "home", "-renderer", renderer, "-grouping", grouping, "-sessionCount", "\(count)", "-archiveCount", "\(archives)"]
        app.launch()
        XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 20))
        return app
    }

    private func row(_ title: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
    }

    private func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }

    func testTableHomeOpensChat() {
        let app = launch("UITableView")
        let chat = row("Scroll indicator", in: app)
        XCTAssertTrue(chat.waitForExistence(timeout: 15))
        screenshot("Home-UITableView")
        chat.tap()
        XCTAssertTrue(app.buttons["Back"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["Settings"].exists)
    }

    func testArchivePressReleasesOnceLikeTable() {
        for renderer in ["UITableView", "UltraList"] {
            let app = launch(renderer, archives: 1000)
            let show = row("Show archived", in: app)
            XCTAssertTrue(show.waitForExistence(timeout: 15))
            screenshot("\(renderer)-archive-collapsed")
            // A held press must stay a button press: the toggle has no
            // long-press action to become.
            show.press(forDuration: 0.65)
            let hide = row("Hide archived", in: app)
            XCTAssertTrue(hide.waitForExistence(timeout: 5), "\(renderer) swallowed release")
            XCTAssertTrue(row("Archived fixture", in: app).waitForExistence(timeout: 5))
            screenshot("\(renderer)-archive-expanded")
            hide.tap()
            XCTAssertTrue(show.waitForExistence(timeout: 5))
            XCTAssertFalse(row("Archived fixture", in: app).exists)
            app.terminate()
        }
    }

    func testDraggingFromArchiveToggleScrollsWithoutSelecting() {
        for grouping in ["flat", "project"] {
            let app = launch("UltraList", grouping: grouping, archives: 12)
            let show = row("Show archived", in: app)
            XCTAssertTrue(show.waitForExistence(timeout: 15))
            let start = show.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            start.press(forDuration: 0.1, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -120)))
            XCTAssertFalse(row("Hide archived", in: app).exists, "a drag must stay a scroll, never toggle the archive")
            XCTAssertTrue(show.exists)
            app.terminate()
        }
    }

    private struct ArchiveSample: Decodable {
        var opening: Bool
        var ms, event, floor, feed, home, listStart, list, label, mount: Double
    }

    /// Small, readable visual fixture for recording the normal/held toggle
    /// and the actual insertion/removal animation in both renderers/layouts.
    func testArchiveControlVisualComparison() {
        let renderers = ProcessInfo.processInfo.environment["HAPPY_ARCHIVE_ULTRA_ONLY"] == "1" ? ["UltraList"] : ["UITableView", "UltraList"]
        for grouping in ["flat", "project"] {
            for renderer in renderers {
                let app = launch(renderer, grouping: grouping, archives: 12)
                let show = row("Show archived", in: app)
                let appeared = show.waitForExistence(timeout: 15)
                if !appeared { print("ARCHIVE FIXTURE ACCESSIBILITY\n\(app.debugDescription)") }
                XCTAssertTrue(appeared)
                screenshot("\(renderer)-\(grouping)-archive-normal")
                show.press(forDuration: 1.5)
                if renderer == "UltraList" { print("ARCHIVE OPEN TOUCHES \(String(describing: app.staticTexts["home.archive-touch-events"].value))") }
                let opened = row("Hide archived", in: app).waitForExistence(timeout: 7)
                if !opened {
                    print("ARCHIVE OPEN PROBE \(String(describing: app.staticTexts["home.archive-probe"].value))")
                    print("ARCHIVE HELD OPEN ACCESSIBILITY\n\(app.debugDescription)")
                }
                XCTAssertTrue(opened)
                Thread.sleep(forTimeInterval: 0.7)
                screenshot("\(renderer)-\(grouping)-archive-open")
                row("Hide archived", in: app).press(forDuration: 1.5)
                if renderer == "UltraList" { print("ARCHIVE CLOSE TOUCHES \(String(describing: app.staticTexts["home.archive-touch-events"].value))") }
                let closed = show.waitForExistence(timeout: 7)
                if !closed {
                    screenshot("\(renderer)-\(grouping)-held-close-failed")
                    if let value = app.staticTexts["home.archive-probe"].value as? String {
                        let raw = XCTAttachment(string: value)
                        raw.name = "\(renderer)-\(grouping)-failed-held-close-stages"; raw.lifetime = .keepAlways; add(raw)
                    }
                    print("ARCHIVE HELD CLOSE ACCESSIBILITY\n\(app.debugDescription)")
                }
                XCTAssertTrue(closed)
                Thread.sleep(forTimeInterval: 0.7)
                screenshot("\(renderer)-\(grouping)-archive-closed")
                if let value = app.staticTexts["home.archive-probe"].value as? String {
                    let raw = XCTAttachment(string: value)
                    raw.name = "\(renderer)-\(grouping)-visual-frame-stages"; raw.lifetime = .keepAlways; add(raw)
                }
                app.terminate()
            }
        }
    }

    func testOptInRealAccountArchiveVisibility() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["HAPPY_RUN_REAL_ARCHIVE"] == "1")
        // XCTest's abort exception can skip Swift defer. Record a failure
        // and return normally so restoration always runs after a UI miss.
        continueAfterFailure = true
        let app = XCUIApplication()
        app.launchArguments = ["-real-archive"]
        app.launch()
        let state = app.staticTexts["home.real-archive-state"]
        XCTAssertTrue(state.waitForExistence(timeout: 10))
        let ready = NSPredicate(format: "value BEGINSWITH 'ready;'")
        let readyExpectation = XCTNSPredicateExpectation(predicate: ready, object: state)
        XCTAssertEqual(XCTWaiter.wait(for: [readyExpectation], timeout: 120), .completed)
        let initial = try XCTUnwrap(state.value as? String)
        print("ARCHIVE REAL BASELINE \(initial)")
        let hidden = initial.hasSuffix("hidden=true")
        defer {
            let restore = app.buttons["home.real-archive-restore"]
            if restore.exists { restore.tap() }
            let confirmed = NSPredicate(format: "value BEGINSWITH 'restored;'")
            let expectation = XCTNSPredicateExpectation(predicate: confirmed, object: state)
            XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 60), .completed, "restore must be server-confirmed before ending the check")
        }
        for index in 0..<4 {
            let opening = index % 2 == 0 ? hidden : !hidden
            let toggle = row(opening ? "Show archived" : "Hide archived", in: app)
            var scrolled = false
            for _ in 0..<30 {
                if toggle.exists && toggle.isHittable { break }
                app.swipeUp(); scrolled = true
            }
            if scrolled {
                // A touch during physics deceleration deliberately stops
                // scrolling instead of selecting. Measure only an at-rest tap.
                let idle = app.descendants(matching: .any)["home.archive-scroll-idle"]
                let settled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == 'idle'"), object: idle)
                guard XCTWaiter.wait(for: [settled], timeout: 5) == .completed else { XCTFail("archive list did not finish scrolling"); return }
                Thread.sleep(forTimeInterval: 0.05)
            }
            guard toggle.exists && toggle.isHittable else { XCTFail("archive visibility control is not reachable"); return }
            toggle.tap()
            guard row(opening ? "Hide archived" : "Show archived", in: app).waitForExistence(timeout: 10) else { XCTFail("archive visibility tap did not change the control"); return }
            Thread.sleep(forTimeInterval: 1)
        }
        let probe = app.staticTexts["home.archive-probe"]
        let samples = try JSONDecoder().decode([ArchiveSample].self, from: Data(try XCTUnwrap(probe.value as? String).utf8))
        let report = "\(initial); first-frame ms: \(samples.map(\.ms))"
        let attachment = XCTAttachment(string: report); attachment.name = "real-account-archive-counts-and-timing"; attachment.lifetime = .keepAlways; add(attachment)
        XCTAssertEqual(samples.count, 4)
        XCTAssertFalse(samples.contains { $0.ms < 0 }, "each toggle must visibly reach the screen")
    }

    /// Touch release → the frame that first shows the archive opening or
    /// closing, on the app's clock, with its stages (`HomeArchiveProbe`): a
    /// cold open, then repeated close/open. Each toggle starts once the last
    /// one's frame was seen and its animation has settled; this is not a
    /// burst of taps.
    func testArchiveToggleFirstFrameTiming() throws {
        try assertArchiveToggleFirstFrameTiming(grouping: "flat")
    }

    func testGroupedArchiveToggleFirstFrameTiming() throws {
        try assertArchiveToggleFirstFrameTiming(grouping: "project")
    }

    private func assertArchiveToggleFirstFrameTiming(grouping: String) throws {
        var report: [(renderer: String, samples: [ArchiveSample])] = []
        let renderers = ProcessInfo.processInfo.environment["HAPPY_ARCHIVE_ULTRA_ONLY"] == "1" ? ["UltraList"] : ["UITableView", "UltraList"]
        for renderer in renderers {
            let app = launch(renderer, grouping: grouping, archives: 1000)
            let show = row("Show archived", in: app)
            let appeared = show.waitForExistence(timeout: 15)
            if !appeared {
                screenshot("\(renderer)-\(grouping)-missing-archive-control")
                print("ARCHIVE FIXTURE ACCESSIBILITY\n\(app.debugDescription)")
            }
            XCTAssertTrue(appeared)
            let probe = app.descendants(matching: .any)["home.archive-probe"]
            func samples() throws -> [ArchiveSample] {
                try JSONDecoder().decode([ArchiveSample].self, from: Data(try XCTUnwrap(probe.value as? String).utf8))
            }
            for index in 0..<12 {
                row(index % 2 == 0 ? "Show archived" : "Hide archived", in: app).tap()
                let deadline = Date().addingTimeInterval(6)
                while try samples().count <= index, Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
                Thread.sleep(forTimeInterval: 0.6)
            }
            report.append((renderer, try samples()))
            let raw = XCTAttachment(string: try XCTUnwrap(probe.value as? String))
            raw.name = "archive-\(grouping)-\(renderer)-raw-stages"; raw.lifetime = .keepAlways; add(raw)
            app.terminate()
        }
        func line(_ entry: (renderer: String, samples: [ArchiveSample])) -> String {
            func list(_ opening: Bool, _ value: (ArchiveSample) -> Double) -> String {
                let values: [String] = entry.samples.filter { $0.opening == opening }.map { String(format: "%.0f", value($0)) }
                return values.joined(separator: "/")
            }
            var parts: [String] = [entry.renderer + ":"]
            for opening in [true, false] {
                var stages = "event " + list(opening, { $0.event }) + "; floor " + list(opening, { $0.floor }) + "; feed " + list(opening, { $0.feed }) + "; home " + list(opening, { $0.home })
                stages += "; listStart " + list(opening, { $0.listStart }) + "; list " + list(opening, { $0.list }) + "; label " + list(opening, { $0.label })
                if opening { stages += "; mount " + list(opening, { $0.mount }) }
                parts.append((opening ? "open" : "close") + " ms " + list(opening, { $0.ms }) + " [" + stages + "]")
            }
            return parts.joined(separator: " ")
        }
        let text = grouping + "\n" + report.map(line).joined(separator: "\n")
        let attachment = XCTAttachment(string: text); attachment.name = "archive-timing"; attachment.lifetime = .keepAlways; add(attachment)
        print("ARCHIVE TIMING\n\(text)")
        for (renderer, samples) in report {
            XCTAssertEqual(samples.count, 12, "\(renderer): one sample per toggle")
            XCTAssertFalse(samples.contains { $0.ms < 0 }, "\(renderer): a toggle never reached the screen")
        }
        let ultra = try XCTUnwrap(report.last?.samples)
        XCTAssertLessThan(ultra.map(\.ms).max() ?? .infinity, 100, text)
    }

    func testUltraHomeOpensChat() {
        let app = launch("UltraList")
        let list = app.descendants(matching: .any)["home.ultralist"]
        XCTAssertTrue(list.waitForExistence(timeout: 15), "must use the real custom UltraList")
        let chat = row("Scroll indicator", in: app)
        XCTAssertTrue(chat.waitForExistence(timeout: 15))
        screenshot("Home-UltraList")
        chat.tap()
        XCTAssertTrue(app.buttons["Back"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["Settings"].exists)
    }

    func testRendererSwitchKeepsAccountAndHomeData() {
        let app = launch("UITableView")
        XCTAssertTrue(row("Scroll indicator", in: app).waitForExistence(timeout: 15))
        app.buttons["Settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))
        let appearance = row("Appearance,", in: app)
        XCTAssertTrue(appearance.waitForExistence(timeout: 10)); appearance.tap()
        let renderer = row("Home list renderer,", in: app)
        XCTAssertTrue(renderer.waitForExistence(timeout: 10)); renderer.tap()
        let choice = app.alerts.buttons["UltraList"]
        XCTAssertTrue(choice.waitForExistence(timeout: 10)); XCTAssertTrue(choice.isHittable)
        choice.tap()
        XCTAssertTrue(app.alerts.firstMatch.waitForNonExistence(timeout: 10))
        XCTAssertTrue(row("Home list renderer,", in: app).label.hasSuffix("UltraList"))
        app.navigationBars["Appearance"].buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))
        app.navigationBars["Settings"].buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.descendants(matching: .any)["home.ultralist"].waitForExistence(timeout: 15))
        XCTAssertTrue(row("Scroll indicator", in: app).exists)
        screenshot("Home-after-live-switch")
        app.terminate()
        let restored = launch("stored")
        XCTAssertTrue(restored.descendants(matching: .any)["home.ultralist"].waitForExistence(timeout: 15))
        XCTAssertTrue(row("Scroll indicator", in: restored).exists)
    }

    func testUltraProjectGroupingAndFastScrollStayResponsive() {
        let grouped = launch("UltraList", grouping: "project")
        XCTAssertTrue(grouped.descendants(matching: .any)["home.ultralist"].waitForExistence(timeout: 15))
        XCTAssertTrue(row("happy", in: grouped).waitForExistence(timeout: 15))
        screenshot("Home-UltraList-projects")
        grouped.terminate()
        let app = launch("UltraList", count: 1000)
        let list = app.descendants(matching: .any)["home.ultralist"]
        XCTAssertTrue(list.waitForExistence(timeout: 15))
        for _ in 0..<4 { list.swipeUp(velocity: .fast) }
        app.buttons["Settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 15))
    }

    func testGroupedHomeOpensChat() {
        let app = launch("UltraList", grouping: "project")
        let list = app.descendants(matching: .any)["home.ultralist"]
        XCTAssertTrue(list.waitForExistence(timeout: 15))
        let chat = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@ OR label BEGINSWITH %@", "Scroll indicator", "chat-nav")).firstMatch
        for _ in 0..<5 {
            if chat.exists && chat.isHittable { break }
            list.swipeUp()
        }
        XCTAssertTrue(chat.exists); XCTAssertTrue(chat.isHittable)
        screenshot("Home-UltraList-grouped-before-selection")
        chat.tap()
        XCTAssertTrue(app.buttons["Back"].waitForExistence(timeout: 15))
        screenshot("Home-UltraList-grouped-selected-chat")
    }

    func testTableProjectGrouping() {
        let app = launch("UITableView", grouping: "project")
        XCTAssertTrue(row("happy", in: app).waitForExistence(timeout: 15))
        screenshot("Home-UITableView-projects")
    }
}
