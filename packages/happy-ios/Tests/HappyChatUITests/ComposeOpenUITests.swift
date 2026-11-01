import XCTest

/// Compose opening an empty conversation on both homes, traced frame by
/// frame (`HAPPY_COMPOSE_TRACE`, `ComposeTrace`): the keyboard comes up
/// before the push starts and the push runs in its frame
/// (`KeyboardPush`), so the push draws from its first frame on, no frame
/// after that comes late beyond a budget, and the composer rides the
/// keyboard as drawn. Each is opened twice: the first time in the process
/// pays for the keyboard's setup, the second is warm.
///
/// The empty conversation's header is Back alone; new work's name and
/// Compose come in with its first send.
///
/// The display link runs at the simulator's 60 Hz; a frame is late past
/// 1.5 of its own duration.
@MainActor
final class ComposeOpenUITests: XCTestCase {
    private let app = XCUIApplication()

    /// The push's first drawn frame may have used up this much of it: one
    /// frame (UIKit's own setup of the push), not most of it.
    private let skippedBudget = 0.2
    /// The longest gap between two of the push's frames after its first,
    /// three 60 Hz frames.
    private let gapBudgetMs = 50.0
    /// How far the composer may stray from the keyboard's progress, warm.
    private let strayBudget = 4.0

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        // No waiting for the app to idle around taps, which reads its
        // accessibility tree on its main thread while the push runs.
        _ = skipsQuiescence
    }

    private var trace: XCUIElement { app.otherElements["compose-trace"] }

    private func traced() -> [String: String] {
        let value = trace.value as? String ?? ""
        var fields: [String: String] = [:]
        for part in value.split(separator: " ") {
            let pair = part.split(separator: "=", maxSplits: 1)
            if pair.count == 2 { fields[String(pair[0])] = String(pair[1]) }
        }
        return fields
    }

    private func launch(_ arguments: [String]) {
        app.launchArguments = arguments
        app.launchEnvironment["HAPPY_COMPOSE_TRACE"] = "1"
        app.launch()
        addTeardownBlock { [app] in app.terminate() }
        XCTAssertTrue(app.buttons["compose"].waitForExistence(timeout: 20))
        // Time for a profiler to attach (`HAPPY_PERF_WAIT`, seconds).
        if let wait = ProcessInfo.processInfo.environment["HAPPY_PERF_WAIT"].flatMap(Double.init) {
            Thread.sleep(forTimeInterval: wait)
        }
        sleep(1)
    }

    /// Compose tapped where it is, then nothing asked of the app until the
    /// push is long over.
    private func compose() -> [String: String] {
        let button = app.buttons["compose"]
        XCTAssertTrue(button.waitForExistence(timeout: 10))
        button.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        sleep(2)
        XCTAssertTrue(trace.waitForExistence(timeout: 10))
        let fields = traced()
        print("COMPOSEOPEN \(trace.value as? String ?? "")")
        return fields
    }

    private func back() {
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(app.buttons["compose"].waitForExistence(timeout: 10))
        sleep(1)
    }

    private func assertSmooth(_ fields: [String: String], warm: Bool, _ label: String, line: UInt = #line) {
        let skipped = Double(fields["openSkipped"] ?? "") ?? 1
        let longest = Double(fields["openLongestMs"] ?? "") ?? .infinity
        let stray = Double(fields["openStray"] ?? "") ?? .infinity
        XCTAssertLessThanOrEqual(skipped, skippedBudget, "\(label): the push's first drawn frame was \(skipped) of the way in: \(fields)", line: line)
        XCTAssertLessThanOrEqual(longest, gapBudgetMs, "\(label): a frame of the push came \(longest) ms after the one before: \(fields)", line: line)
        if warm {
            XCTAssertLessThanOrEqual(stray, strayBudget, "\(label): the composer left the keyboard by \(stray): \(fields)", line: line)
        }
        XCTAssertGreaterThan(Int(fields["openFrames"] ?? "") ?? 0, 15, "\(label): the push wasn't traced: \(fields)", line: line)
        XCTAssertEqual(fields["responder"], "composer", "\(label): the composer didn't take the keyboard: \(fields)", line: line)
        let appeared = Double(fields["appearKeyboard"] ?? "") ?? .infinity
        XCTAssertLessThan(appeared, Double(app.windows.firstMatch.frame.height) - 200, "\(label): the keyboard wasn't up as the push ended: \(fields)", line: line)
    }

    /// Back alone: no name's capsule, no Compose.
    private func assertEmptyHeader(_ label: String, line: UInt = #line) {
        let bar = app.navigationBars.firstMatch
        XCTAssertTrue(bar.buttons.firstMatch.exists, "\(label): no Back", line: line)
        XCTAssertFalse(bar.buttons["compose"].exists, "\(label): the empty conversation has Compose", line: line)
        XCTAssertFalse(app.otherElements["chat-capsule"].exists, "\(label): the empty conversation has a title", line: line)
    }

    func testAgentComposeOpensWithTheKeyboardInOneMotion() {
        launch(["-screen", "groupedHome"])
        let cold = compose()
        assertSmooth(cold, warm: false, "cold")
        assertEmptyHeader("cold")
        back()
        let warm = compose()
        assertSmooth(warm, warm: true, "warm")
        assertEmptyHeader("warm")
    }

    func testLegacyComposeOpensWithTheKeyboardInOneMotion() {
        launch(["-screen", "home", "-freshSettings"])
        let cold = compose()
        assertSmooth(cold, warm: false, "cold")
        assertEmptyHeader("cold")
        back()
        let warm = compose()
        assertSmooth(warm, warm: true, "warm")
        assertEmptyHeader("warm")
    }

    /// New work's header is Back alone; its first send brings the name and
    /// Compose in. Light, or dark with `HAPPY_APPEARANCE=dark`.
    func testNewWorkHeaderComesInWithTheFirstSend() {
        let name = ProcessInfo.processInfo.environment["HAPPY_APPEARANCE"] ?? "light"
        launch(["-screen", "groupedHome", "-\(name)"])
        _ = compose()
        assertEmptyHeader(name)
        capture("compose-empty-header-\(name)")
        let composer = app.textViews["composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        for character in "Audit exports" {
            let key = app.keyboards.firstMatch.keys[character == " " ? "space" : String(character)]
            XCTAssertTrue(key.waitForExistence(timeout: 3), "no key \(character)")
            key.tap()
        }
        let send = app.buttons["Send"]
        XCTAssertTrue(send.waitForExistence(timeout: 5))
        send.tap()
        XCTAssertTrue(app.otherElements["chat-capsule"].waitForExistence(timeout: 10), "the name didn't come in with the first send")
        XCTAssertTrue(app.navigationBars.firstMatch.buttons["compose"].waitForExistence(timeout: 5), "Compose didn't come back")
        sleep(1)
        capture("compose-header-after-send-\(name)")
    }

    private func capture(_ name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let directory = ProcessInfo.processInfo.environment["HAPPY_PREVIEW_DIR"] {
            try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name).png"))
        }
    }
}
