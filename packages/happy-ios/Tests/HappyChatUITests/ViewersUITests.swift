import XCTest

/// Viewers in the headers of a team server's screens (`-screen viewers`,
/// `ViewersHarness`): the three tiers on a conversation, a todo list and
/// a document, their list on a tap, a header laid out the same with
/// nobody and with ten, the slot gone on a server without viewers, and
/// people coming and going over the stream. With `HAPPY_PREVIEW_DIR` set
/// (`TEST_RUNNER_HAPPY_PREVIEW_DIR` through xcodebuild), it writes what it
/// saw there.
@MainActor
final class ViewersUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
    }

    private func keep(_ name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let directory = ProcessInfo.processInfo.environment["HAPPY_PREVIEW_DIR"] {
            try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name).png"))
        }
    }

    private func launch(_ screen: String, _ viewers: String, dark: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-screen", "viewers", "-open", screen, "-viewers", viewers] + (dark ? ["-dark"] : [])
        app.launch()
        return app
    }

    /// The probe's "title=x,y,w,h slot=x,y,w,h", once the screen settled.
    private func probe(_ app: XCUIApplication) -> (title: String, slot: String) {
        let bar = app.navigationBars["viewers-bar"]
        XCTAssertTrue(bar.waitForExistence(timeout: 20), "no probe")
        let value = bar.value as? String ?? ""
        let parts = Dictionary(uniqueKeysWithValues: value.split(separator: " ").compactMap { part -> (String, String)? in
            let pair = part.split(separator: "=", maxSplits: 1).map(String.init)
            return pair.count == 2 ? (pair[0], pair[1]) : nil
        })
        return (parts["title"] ?? "none", parts["slot"] ?? "none")
    }

    func testEachTierOnEachHeaderAndTheirList() {
        for screen in ["chat", "todo", "document"] {
            for dark in [false, true] {
                let app = launch(screen, "tiers", dark: dark)
                let slot = app.buttons["viewers"]
                XCTAssertTrue(slot.waitForExistence(timeout: 20), "no viewers on \(screen)")
                XCTAssertEqual(slot.label, "1 here now, 3 before")
                Thread.sleep(forTimeInterval: 2.5)
                keep("viewers-tiers-\(screen)-\(dark ? "dark" : "light")")
                if !dark {
                    slot.tap()
                    for row in ["Kirill · here now", "Anna · 4 min ago", "Max · Nov 12", "Ada · Nov 11"] {
                        XCTAssertTrue(app.buttons[row].waitForExistence(timeout: 5), "no \(row) on \(screen)")
                    }
                    Thread.sleep(forTimeInterval: 0.6)
                    keep("viewers-list-\(screen)")
                }
                app.terminate()
            }
        }
    }

    func testTheHeaderIsTheSameWithNobodyAndWithTen() {
        for screen in ["chat", "todo", "document"] {
            var titles: [String: String] = [:]
            var slots: [String: String] = [:]
            for viewers in ["none", "ten"] {
                let app = launch(screen, viewers)
                if viewers == "ten" {
                    XCTAssertTrue(app.buttons["viewers"].waitForExistence(timeout: 20))
                    XCTAssertEqual(app.buttons["viewers"].label, "3 here now, 7 before")
                }
                let (title, slot) = probe(app)
                titles[viewers] = title
                slots[viewers] = slot
                Thread.sleep(forTimeInterval: 1)
                keep("viewers-\(viewers)-\(screen)")
                app.terminate()
            }
            XCTAssertNotEqual(titles["none"], "none", "no title found on \(screen)")
            XCTAssertEqual(titles["none"], titles["ten"], "the title moved on \(screen)")
            XCTAssertEqual(slots["none"], slots["ten"], "the slot moved on \(screen)")
            print("VIEWERS-COMPARE \(screen) none title=\(titles["none"] ?? "") slot=\(slots["none"] ?? "") ten title=\(titles["ten"] ?? "") slot=\(slots["ten"] ?? "")")
        }
    }

    func testAServerWithoutViewersShowsNoSlot() {
        let app = launch("chat", "old")
        XCTAssertTrue(app.buttons["compose"].waitForExistence(timeout: 20))
        Thread.sleep(forTimeInterval: 3)
        XCTAssertFalse(app.buttons["viewers"].exists)
        keep("viewers-old-chat")
        app.terminate()
    }

    /// People arrive and leave every three seconds, for the recording
    /// and the Animation Hitches trace: on the chat, then the todo list.
    /// `VIEWERS_LIVE_SECONDS` sets how long each, `VIEWERS_LIVE_SHOTS=0`
    /// takes no screenshots.
    func testPeopleComeAndGo() {
        let environment = ProcessInfo.processInfo.environment
        let seconds = Double(environment["VIEWERS_LIVE_SECONDS"] ?? "") ?? 24
        // Off for a timing pass: a screenshot is work the trace would count.
        let shots = environment["VIEWERS_LIVE_SHOTS"] != "0"
        for screen in ["chat", "todo"] {
            let app = launch(screen, "live")
            XCTAssertTrue(app.buttons["viewers"].waitForExistence(timeout: 20))
            let start = Date()
            var index = 0
            while Date().timeIntervalSince(start) < seconds {
                Thread.sleep(forTimeInterval: 3)
                if shots { keep(String(format: "viewers-live-\(screen)-%02d", index)) }
                index += 1
            }
            app.terminate()
        }
    }
}
