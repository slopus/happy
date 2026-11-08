import ObjectiveC
import UIKit
import XCTest

/// Home's microphone and the composer's, on a phone signed in to a Happy
/// Agent: Telegram's hold, slide left, slide up and tap, and a task started
/// from what was said. The driver puts a spoken sentence in the app's
/// Documents (`RECORD_AUDIO`, played in place of the microphone so every
/// run hears the same words) and films the run (`HAPPY_SCREEN_FILM`).
@MainActor
final class RecordButtonUITests: XCTestCase {
    private let app = XCUIApplication()
    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

    override func setUp() {
        continueAfterFailure = false
        _ = Self.skipsQuiescence
        let environment = ProcessInfo.processInfo.environment
        app.launchEnvironment["HAPPY_DICTATION_AUDIO"] = environment["RECORD_AUDIO"] ?? "dictation.wav"
        if let film = environment["RECORD_FILM"] {
            app.launchEnvironment["HAPPY_SCREEN_FILM"] = film
            app.launchEnvironment["HAPPY_SCREEN_FILM_SECONDS"] = environment["RECORD_FILM_SECONDS"] ?? "90"
        }
        // Settings › Agents › Open task after dictating, for this run only.
        if name.contains("StaysHome") { app.launchArguments += ["-dictationStaysHome", "true"] }
        app.launch()
    }

    private static let skipsQuiescence: Bool = {
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

    private func pause(_ seconds: TimeInterval) { Thread.sleep(forTimeInterval: seconds) }

    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// Answers the system's questions: the screen recording, speech
    /// recognition, the microphone.
    private func allowAlerts(for seconds: TimeInterval) {
        let deadline = Date().addingTimeInterval(seconds)
        repeat {
            for alert in [springboard.alerts.firstMatch, app.alerts.firstMatch] where alert.exists {
                for title in ["Record Screen", "Start Recording", "Allow", "OK"] where alert.buttons[title].exists {
                    alert.buttons[title].tap()
                    break
                }
            }
            pause(0.5)
        } while Date() < deadline
    }

    private var record: XCUIElement { app.buttons["record-button"].firstMatch }

    /// Home, pairing first on a simulator with no computer yet: a driver
    /// outside the test answers `HAPPY_PAIR_READY` with the throwaway
    /// daemon's pairing link and confirms it (`scripts/perf-gym/gym.py`'s
    /// `pair`), as `UITests` does.
    private func home() {
        if record.waitForExistence(timeout: 8) { return }
        print("HAPPY_PAIR_READY")
        let match = app.buttons["Emoji match"]
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
        XCTAssertTrue(record.waitForExistence(timeout: 90), "no microphone on home after pairing")
    }

    /// The gym's "Bug triage" chat, its row first scrolled clear of the
    /// toolbar.
    private func openBugTriage() {
        let row = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'row:' AND identifier ENDSWITH ':Bug triage'")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        app.swipeUp()
        pause(1)
        row.tap()
    }

    /// The home screen as it is: for checking the phone before a film.
    func testProbe() {
        home()
        allowAlerts(for: 4)
        pause(4)
        capture("probe-home")
        print("RECORD_PROBE exists=\(record.exists) hittable=\(record.exists && record.isHittable)")
    }

    /// What `composer` read while it was watched, each change once: the
    /// words as dictation wrote them in.
    private func live(_ composer: XCUIElement, for seconds: TimeInterval) -> [String] {
        var seen: [String] = []
        let deadline = Date().addingTimeInterval(seconds)
        repeat {
            let value = composer.value as? String ?? ""
            if value.contains(" "), value != seen.last { seen.append(value) }
            pause(0.2)
        } while Date() < deadline
        print("RECORD_LIVE \(seen)")
        return seen
    }

    /// The whole story, filmed: idle; a tap that lands locked, cancelled;
    /// a hold slid away; a hold let go, whose words start a task that
    /// opens; then that task's composer: the microphone and send changing
    /// places, a hold whose words come in as they are said and go when let
    /// go, a locked recording cancelled back to empty, one stopped into a
    /// draft, and one sent with the big circle.
    func testFilm() {
        home()
        allowAlerts(for: 3)
        // Speech recognition is asked on the first press; asked before,
        // the tap lands locked, and Cancel ends it.
        record.tap()
        allowAlerts(for: 3)
        if !app.buttons["record-cancel"].exists {
            pause(1)
            record.tap()
        }
        pause(2.5)
        capture("1-tap-locked")
        XCTAssertTrue(app.buttons["record-cancel"].waitForExistence(timeout: 3))
        app.buttons["record-cancel"].tap()
        pause(1.5)
        capture("2-idle")

        let center = record.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        // Hold, then slide left past the threshold: cancelled.
        center.press(forDuration: 2.5, thenDragTo: center.withOffset(CGVector(dx: -220, dy: 0)), withVelocity: .slow, thenHoldForDuration: 0.3)
        pause(1.5)

        // Hold while the sentence plays, let go: a new task starts with it, and opens.
        center.press(forDuration: 6.5)
        let composer = app.textViews["composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        pause(4)
        capture("3-task-started")
        // Sent, not typed in: the composer is empty again.
        XCTAssertFalse((composer.value as? String ?? "").contains("haiku"), "the words were typed in, not sent")

        // The task's composer, empty: the microphone holds send's place.
        let chatRecord = app.buttons["record-button"].firstMatch
        XCTAssertTrue(chatRecord.waitForExistence(timeout: 30), "no microphone in the task's composer")
        pause(1)
        capture("4-chat-mic")
        composer.tap()
        composer.typeText("Thanks")
        pause(1)
        capture("5-chat-send")
        for _ in 0..<6 { composer.typeText(XCUIKeyboardKey.delete.rawValue) }
        pause(1.5)

        // Held: the words come into the composer as they are said; let
        // go, and they go as the next message.
        chatRecord.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 5.5)
        pause(3)
        capture("5b-chat-held-sent")
        XCTAssertFalse((composer.value as? String ?? "").contains("Write"), "let go, the words stayed in the composer")
        XCTAssertTrue(chatRecord.waitForExistence(timeout: 10))
        pause(1)

        // A tap lands locked: the words come into the composer as they
        // are said; cancel, and it is empty again.
        chatRecord.tap()
        let heard = live(composer, for: 2.5)
        capture("6a-chat-live")
        XCTAssertGreaterThanOrEqual(heard.count, 3, "the words didn't come in as they were said: \(heard)")
        XCTAssertTrue(app.buttons["record-cancel"].waitForExistence(timeout: 3))
        app.buttons["record-cancel"].tap()
        pause(1.5)
        capture("6b-chat-cancelled")
        XCTAssertFalse((composer.value as? String ?? "").contains("Write"), "cancel left the words in the composer")
        XCTAssertTrue(chatRecord.waitForExistence(timeout: 5))

        // Locked again; stop: the words wait in the composer.
        chatRecord.tap()
        let growing = live(composer, for: 4)
        capture("6-chat-locked")
        let stop = app.buttons["record-stop"]
        XCTAssertTrue(stop.waitForExistence(timeout: 3))
        stop.tap()
        pause(3)
        capture("7-chat-draft")
        print("RECORD_DRAFT \(composer.value as? String ?? "")")
        XCTAssertTrue((composer.value as? String ?? "").contains("haiku"), "stop didn't leave the words as a draft")
        let draft = composer.value as? String ?? ""
        // The words grew into the draft, nothing doubled or run together.
        for words in growing where !words.isEmpty {
            XCTAssertTrue(draft.hasPrefix(words), "\"\(words)\" isn't how the draft \"\(draft)\" begins")
        }
        composer.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: draft.count + 2))
        pause(1.5)

        // Locked again; the big circle sends.
        XCTAssertTrue(chatRecord.waitForExistence(timeout: 10))
        chatRecord.tap()
        pause(4)
        let send = app.buttons["record-send"]
        XCTAssertTrue(send.waitForExistence(timeout: 3))
        send.tap()
        pause(5)
        capture("8-chat-sent")
    }

    /// The morph, filmed for slow motion: home's toolbar turning into the
    /// bar and back, held and slid away, then tapped (locked) and
    /// cancelled; then the same in a chat's composer, where the bar
    /// stretches out of the microphone under the text. Nothing is sent.
    func testMorph() {
        home()
        allowAlerts(for: 3)
        // The first press may ask for speech recognition.
        record.tap()
        allowAlerts(for: 3)
        if app.buttons["record-cancel"].waitForExistence(timeout: 2) { app.buttons["record-cancel"].tap() }
        pause(2)
        capture("morph-0-rest")
        print("RECORD_MORPH mark hold")
        let center = record.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        center.press(forDuration: 2.5, thenDragTo: center.withOffset(CGVector(dx: -220, dy: 0)), withVelocity: .slow, thenHoldForDuration: 0.3)
        pause(2)
        print("RECORD_MORPH mark tap")
        record.tap()
        pause(2)
        capture("morph-1-home-locked")
        XCTAssertTrue(app.buttons["record-cancel"].waitForExistence(timeout: 3))
        app.buttons["record-cancel"].tap()
        pause(2)
        capture("morph-2-home-back")

        openBugTriage()
        let composer = app.textViews["composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        let chatRecord = app.buttons["record-button"].firstMatch
        XCTAssertTrue(chatRecord.waitForExistence(timeout: 10))
        pause(2)
        capture("morph-3-chat-rest")
        print("RECORD_MORPH mark chat")
        chatRecord.tap()
        pause(2)
        capture("morph-4-chat-locked")
        XCTAssertTrue(app.buttons["record-cancel"].waitForExistence(timeout: 3))
        app.buttons["record-cancel"].tap()
        pause(2)
        let chatCenter = chatRecord.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        chatCenter.press(forDuration: 2.5, thenDragTo: chatCenter.withOffset(CGVector(dx: -220, dy: 0)), withVelocity: .slow, thenHoldForDuration: 0.3)
        pause(2)
        capture("morph-5-chat-back")
    }

    /// A chat's composer, filmed for slow motion: the microphone at rest;
    /// held, slid slowly to cancel; then a character typed, deleted and
    /// typed again, so send and the microphone morph into each other in
    /// place; then fast typing and deleting, which must not stutter.
    /// Nothing is sent.
    func testComposerSwap() {
        home()
        allowAlerts(for: 3)
        openBugTriage()
        let composer = app.textViews["composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        composer.tap()
        // The on-screen keyboard's keys, as a thumb types: `typeText`
        // drops the simulator's keyboard for each string it sends.
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
        // Shift is on at the start of a message: the keys read capitals.
        func key(_ name: String) {
            let lower = keyboard.keys[name]
            (lower.exists ? lower : keyboard.keys[name.uppercased()]).tap()
        }
        let delete = { keyboard.keys["delete"].tap() }
        // An earlier run's draft, from its end.
        composer.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        for _ in 0..<(composer.value as? String ?? "").count + 2 { delete() }
        let chatRecord = app.buttons["record-button"].firstMatch
        XCTAssertTrue(chatRecord.waitForExistence(timeout: 10))
        pause(2)
        capture("swap-0-rest")
        print("RECORD_SWAP mark hold")
        let center = chatRecord.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        center.press(forDuration: 3, thenDragTo: center.withOffset(CGVector(dx: -240, dy: 0)), withVelocity: 120, thenHoldForDuration: 0.3)
        pause(2)
        capture("swap-1-empty")
        print("RECORD_SWAP mark type")
        key("a")
        pause(2)
        capture("swap-2-send")
        print("RECORD_SWAP mark delete")
        delete()
        pause(2)
        capture("swap-3-mic")
        print("RECORD_SWAP mark again")
        key("a")
        pause(2)
        capture("swap-4-send")
        print("RECORD_SWAP mark fast")
        delete()
        key("h")
        delete()
        key("o")
        key("k")
        delete()
        delete()
        key("o")
        key("k")
        pause(2)
        capture("swap-5-send")
        XCTAssertEqual((composer.value as? String)?.lowercased(), "ok")
        delete()
        delete()
    }

    /// Telegram's cancel, filmed for slow motion: on home, the bubble
    /// dragged up and left and let go, then slid away, so each time the
    /// dot's bin drops in search's magnifier; then the same in a chat,
    /// where the bin drops in add. The call is in the header before
    /// Settings; the microphone sits before compose and doesn't move
    /// while it records.
    func testCancel() {
        home()
        allowAlerts(for: 3)
        record.tap()
        allowAlerts(for: 3)
        if app.buttons["record-cancel"].waitForExistence(timeout: 2) { app.buttons["record-cancel"].tap() }
        pause(2)
        // The call in the header before Settings; the microphone before
        // compose in the toolbar.
        let call = app.buttons["voice-call"].firstMatch
        let settings = app.buttons["settings"].firstMatch
        let compose = app.buttons["compose"].firstMatch
        print("RECORD_CANCEL bars call=\(call.frame) settings=\(settings.frame) mic=\(record.frame) compose=\(compose.frame)")
        XCTAssertLessThan(call.frame.maxX, settings.frame.minX, "the call before Settings")
        XCTAssertEqual(call.frame.midY, settings.frame.midY, accuracy: 1, "the call in the header")
        XCTAssertEqual(call.frame.size, settings.frame.size, "the call as Settings")
        XCTAssertLessThan(record.frame.maxX, compose.frame.minX, "the microphone before compose")
        capture("cancel-bars")
        let resting = record.frame
        capture("cancel-0-home")
        print("RECORD_CANCEL mark drag")
        let center = record.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        // Up and left, short of either threshold, held, then let go:
        // past 100 left on release is a cancel.
        center.press(forDuration: 1.5, thenDragTo: center.withOffset(CGVector(dx: -140, dy: -45)), withVelocity: 120, thenHoldForDuration: 0.8)
        pause(2.5)
        print("RECORD_CANCEL mark slide")
        center.press(forDuration: 1.5, thenDragTo: center.withOffset(CGVector(dx: -240, dy: 0)), withVelocity: 160, thenHoldForDuration: 0.3)
        pause(0.4)
        print("RECORD_CANCEL during mic=\(record.frame)")
        XCTAssertEqual(record.frame.midX, resting.midX, accuracy: 1, "the microphone moved")
        pause(2.5)
        capture("cancel-1-home-back")

        openBugTriage()
        let chatRecord = app.buttons["record-button"].firstMatch
        XCTAssertTrue(chatRecord.waitForExistence(timeout: 10))
        pause(2)
        print("RECORD_CANCEL mark chat")
        let chatCenter = chatRecord.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        chatCenter.press(forDuration: 1.5, thenDragTo: chatCenter.withOffset(CGVector(dx: -240, dy: 0)), withVelocity: 160, thenHoldForDuration: 0.3)
        pause(3)
        capture("cancel-2-chat-back")
    }

    /// Settings › Agents › Open task after dictating off: let go, and the
    /// task starts while home stays.
    func testFilmStaysHome() {
        home()
        allowAlerts(for: 3)
        pause(1.5)
        let center = record.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        center.press(forDuration: 6.5)
        pause(6)
        capture("9-home-stayed")
        XCTAssertFalse(app.textViews["composer"].exists, "the task opened")
        XCTAssertTrue(record.exists, "home went")
    }
}
