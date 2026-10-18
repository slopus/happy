import XCTest

/// Device QA for the UltraList chat (`HappyChatHarness -chatUltraList
/// -qaProbe`): each test drives one fixture chat with synthesized touches,
/// takes screenshots, and attaches the probe's per-window cadence and drift
/// (`ChatUltraQAProbe`). Fixture feed, offline: sends, permissions and
/// answers go to `FixtureChatControls`, never to a server.
///
/// Nothing reads the app while it moves: every accessibility read makes the
/// app serialize its tree on the main thread (125–200 ms on an iPhone 12),
/// which would show up as the scroller's missed frames. A gesture is
/// followed by a fixed wait, and only then by reads.
///
/// System alerts are never answered: one fails and stops the test.
final class ChatUltraQATests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        _ = skipsQuiescence
        // Ahead of XCTest's own handler, which would tap a default button.
        addUIInterruptionMonitor(withDescription: "Fail on any system alert") { alert in
            XCTFail("A system alert appeared and was left unanswered: \(alert.label)")
            return true
        }
    }

    private func launch(_ fixture: String, run: String, extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-fixture", fixture, "-chatUltraList", "-qaProbe", "-qaRun", run] + extra
        app.launch()
        let alerts = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts
        XCTAssertEqual(alerts.count, 0, "A system alert is up: \(alerts.firstMatch.label). Stopping without answering it.")
        return app
    }

    private func read(_ app: XCUIApplication, _ name: String) -> [String: Any] {
        let element = app.otherElements[name]
        guard element.exists, let value = element.value as? String,
              let object = try? JSONSerialization.jsonObject(with: Data(value.utf8)) as? [String: Any] else { return [:] }
        return object
    }

    private func state(_ app: XCUIApplication) -> [String: Any] {
        read(app, "chat-ultra-qa")["state"] as? [String: Any] ?? [:]
    }

    private func windows(_ app: XCUIApplication) -> [[String: Any]] {
        read(app, "chat-ultra-qa")["windows"] as? [[String: Any]] ?? []
    }

    private func wait(_ timeout: TimeInterval, every interval: TimeInterval = 0.5, until condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > deadline { return false }
            Thread.sleep(forTimeInterval: interval)
        }
        return true
    }

    private func attach(_ name: String, _ text: String) {
        let attachment = XCTAttachment(string: text)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        print("ChatUltraQA \(name): \(text.prefix(4000))")
    }

    private func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        mark(name)
    }

    /// Wall-clock marks, to place events in the test's screen recording.
    private func mark(_ event: String) {
        attach("mark \(event)", "{\"event\":\"\(event)\",\"wall\":\(Date().timeIntervalSince1970)}")
    }

    /// The gate every clip starts with: UltraList is the renderer, its list
    /// is mounted, no collection view is in the chat list, rows are drawn.
    private func assertUltraReady(_ app: XCUIApplication, _ label: String) {
        let ready = wait(30) {
            let s = state(app)
            return (s["displayReady"] as? Bool) == true && ((s["rows"] as? NSNumber)?.intValue ?? 0) > 0
        }
        let s = state(app)
        attach("\(label) state", "\(s)")
        XCTAssertTrue(ready, "\(label): rows never drew")
        XCTAssertEqual(s["renderer"] as? String, "UltraList", label)
        XCTAssertEqual(s["ultraMounted"] as? Bool, true, label)
        XCTAssertEqual((s["collectionViews"] as? NSNumber)?.intValue, 0, label)
    }

    /// Waits, without reading the app, for the last action's motion to end
    /// and its window to close (half a second of stillness), then until the
    /// window is on disk, reading once a second.
    @discardableResult
    private func settle(_ app: XCUIApplication, after count: Int, quiet: TimeInterval = 3, timeout: TimeInterval = 15) -> [[String: Any]] {
        Thread.sleep(forTimeInterval: quiet)
        let closed = wait(timeout, every: 1) {
            let s = state(app)
            return ((s["windowCount"] as? NSNumber)?.intValue ?? 0) > count && (s["moving"] as? Bool) == false
        }
        if !closed { attach("unsettled", "\(state(app))") }
        return windows(app)
    }

    private func windowCount(_ app: XCUIApplication) -> Int {
        (state(app)["windowCount"] as? NSNumber)?.intValue ?? 0
    }

    private func point(_ app: XCUIApplication, _ x: CGFloat, _ y: CGFloat) -> XCUICoordinate {
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y))
    }

    // MARK: Smoke

    /// Device, signing and capture: the long chat on UltraList, a fling
    /// back and one forward, screenshots and the probe's windows.
    func testSmokeLongFling() {
        let app = launch("long", run: "smoke")
        assertUltraReady(app, "smoke")
        Thread.sleep(forTimeInterval: 1)
        screenshot("smoke-newest")
        let size = app.windows.firstMatch.frame.size
        var count = settle(app, after: -1, quiet: 0).count
        point(app, size.width / 2, size.height * 0.3).press(forDuration: 0.02, thenDragTo: point(app, size.width / 2, size.height * 0.75), withVelocity: 2500, thenHoldForDuration: 0)
        settle(app, after: count)
        screenshot("smoke-after-fling-back")
        count = windowCount(app)
        point(app, size.width / 2, size.height * 0.7).press(forDuration: 0.02, thenDragTo: point(app, size.width / 2, size.height * 0.25), withVelocity: 2500, thenHoldForDuration: 0)
        settle(app, after: count)
        screenshot("smoke-after-fling-forward")
        attach("smoke windows", "\(windows(app))")
        attach("smoke controls", "\(read(app, "chat-ultra-qa-controls"))")
    }
}
