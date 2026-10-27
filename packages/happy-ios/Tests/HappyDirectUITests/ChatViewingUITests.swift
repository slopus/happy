import ObjectiveC
import UIKit
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

/// Reading a Stem Cell conversation against a real throwaway Happy Agent:
/// nothing of the transcript under the composer, the way back to the
/// newest message, and its pictures opened whole, one after another. The
/// driver (`.context/drive.sh`) pairs and records; the agent makes the
/// conversation these read the first time.
@MainActor
final class ChatViewingUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() {
        continueAfterFailure = false
        print("ChatViewingUITests skips quiescence: \(skipsQuiescence)")
        app.launchEnvironment["STEM_DIRECT"] = "1"
        app.launch()
    }

    /// The computer's Theme in its settings, gone round to `name`
    /// ("Light", "Dark", "Adaptive"), then back to the conversation.
    private func theme(_ name: String) {
        app.tapBack()
        pause(1)
        let mark = element("stem-settings-mark")
        XCTAssertTrue(mark.waitForExistence(timeout: 5))
        mark.tap()
        let row = element("stem-settings:theme")
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        for _ in 0..<3 where !row.label.contains(name) {
            row.tap()
            pause(0.8)
        }
        XCTAssertTrue(row.label.contains(name), "the theme never reached \(name)")
        app.buttons["stem-glass-back"].firstMatch.tap()
        pause(1)
        let happy = element("stem-row:space:Happy")
        XCTAssertTrue(happy.waitForExistence(timeout: 5))
        happy.tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        pause(2)
    }

    private func pause(_ seconds: TimeInterval) { Thread.sleep(forTimeInterval: seconds) }

    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func element(_ id: String) -> XCUIElement { app.descendants(matching: .any)[id] }

    private var composer: XCUIElement { app.textViews["stem-composer"] }
    private var working: XCUIElement { element("stem-working") }
    private var jump: XCUIElement { app.buttons["stem-jump-latest"] }
    private var pictures: XCUIElementQuery {
        app.descendants(matching: .any).matching(identifier: "stem-media").matching(NSPredicate(format: "label ENDSWITH %@", ".png"))
    }

    /// Pairs if this simulator has no computer yet, then opens Happy's
    /// conversation, asking the agent for four pictures and a long answer
    /// the first time.
    private func openConversation() {
        let any = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "stem-row:")).firstMatch
        if !any.waitForExistence(timeout: 8) {
            print("STEM_PAIR_READY")
            let match = app.buttons["Emoji match"]
            XCTAssertTrue(match.waitForExistence(timeout: 120), "pairing never showed its emoji")
            pause(1.5)
            match.tap()
            XCTAssertTrue(any.waitForExistence(timeout: 90))
        }
        pause(1)
        let happy = element("stem-row:space:Happy")
        XCTAssertTrue(happy.waitForExistence(timeout: 10))
        happy.tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        pause(3)
        if pictures.count < 4 {
            composer.tap()
            composer.typeText(
                "In a temporary folder make four 600x400 PNG pictures, each one solid colour (red, green, blue, orange) with its number 1 to 4 drawn large in white "
                    + "(python, sips or ImageMagick, whatever you have). Present all four inline with one present_files call, in order 1 to 4. "
                    + "Then write the numbers 1 to 80, one per line, and nothing else."
            )
            pause(0.5)
            app.buttons["Send"].tap()
            if app.buttons["Continue"].waitForExistence(timeout: 2) { app.buttons["Continue"].tap() }
            let deadline = Date().addingTimeInterval(420)
            pause(5)
            while Date() < deadline, pictures.count < 4 || working.exists { pause(2) }
            XCTAssertGreaterThanOrEqual(pictures.count, 4, "the agent never presented four pictures")
        }
        if composer.hasFocus { app.swipeDown(velocity: .slow) }
        pause(1.5)
    }

    /// Scrolls the transcript up by `screens` screens, in held drags that
    /// don't fling.
    private func scrollUp(_ screens: Int) {
        for _ in 0..<(screens * 2) {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25)).press(
                forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7)),
                withVelocity: .slow, thenHoldForDuration: 0.3
            )
            pause(0.4)
        }
    }

    /// Nothing of the transcript is legible under the composer, beside it
    /// or in the last of the list above it, as on home: read mid-transcript,
    /// where messages go on past the composer, light and dark, every stroke
    /// there is blurred soft, where the transcript's own text is sharp.
    func testNothingUnderTheComposer() {
        openConversation()
        let card = element("stem-input")
        XCTAssertTrue(card.exists)
        for name in ["Light", "Dark"] {
            theme(name)
            scrollUp(1)
            pause(1.5)
            let shot = XCUIScreen.main.screenshot()
            capture("ground-\(name)")
            let frame = card.frame
            // Under the card, clear of the home indicator in the middle,
            // the gap beside it, and the list's last 12 above it.
            let under = CGRect(x: 2, y: frame.maxY + 2, width: 90, height: app.frame.height - frame.maxY - 4)
            let beside = CGRect(x: 1, y: frame.minY + 4, width: max(1, frame.minX - 2), height: frame.height - 8)
            let above = CGRect(x: 0, y: frame.minY - 12, width: app.frame.width, height: 10)
            // The transcript's own lines, well clear of both edges: sharp.
            let transcript = CGRect(x: 0, y: app.frame.height * 0.35, width: app.frame.width, height: app.frame.height * 0.3)
            let sharp = Self.sharpEdges(in: shot.image, area: transcript)
            XCTAssertGreaterThan(sharp, 500, "\(name): the transcript itself reads as blurred (\(sharp))")
            for (place, area) in [("under", under), ("beside", beside), ("above", above)] {
                let edges = Self.sharpEdges(in: shot.image, area: area)
                print("STEM_EDGES \(name) \(place)=\(edges) transcript=\(sharp)")
                XCTAssertLessThan(edges, 20, "\(name): \(edges) sharp strokes show \(place) the composer")
            }
        }
        theme("Adaptive")
    }

    /// The chat's edges beside home's, light and dark: each scrolled so
    /// its content runs under the glass header and under the composer.
    /// Pictures for the eye (`edges-*`); the composer's foot is checked by
    /// `testNothingUnderTheComposer`.
    func testEdgesLikeHome() {
        openConversation()
        for name in ["Light", "Dark"] {
            theme(name)
            // At the newest, the transcript runs on under the header.
            capture("edges-chat-newest-\(name)")
            scrollUp(1)
            pause(1.5)
            capture("edges-chat-\(name)")
            // Scrolled slowly the rest of the way, for the video.
            for _ in 0..<2 {
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.65)).press(
                    forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35)),
                    withVelocity: .slow, thenHoldForDuration: 0.4
                )
                pause(0.6)
            }
            app.tapBack()
            pause(1.5)
            // Home's list a little down, so rows are under its header and its dock.
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6)).press(
                forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)),
                withVelocity: .slow, thenHoldForDuration: 0.4
            )
            pause(1.5)
            capture("edges-home-\(name)")
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4)).press(
                forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7)),
                withVelocity: .slow, thenHoldForDuration: 0.4
            )
            pause(1)
            let happy = element("stem-row:space:Happy")
            XCTAssertTrue(happy.waitForExistence(timeout: 5))
            happy.tap()
            XCTAssertTrue(composer.waitForExistence(timeout: 5))
            pause(2)
        }
        theme("Adaptive")
    }

    /// The pixels in `area` (in points) where the image steps by more than
    /// 40 of 255 within two pixels across or down, as a glyph's stroke
    /// does: a blur, a scrim's feather or the card's soft shadow never do.
    private static func sharpEdges(in image: UIImage, area: CGRect) -> Int {
        guard let cg = image.cgImage, let data = cg.dataProvider?.data, let bytes = CFDataGetBytePtr(data) else { return -1 }
        let scale = CGFloat(cg.width) / image.size.width
        let pixels = CGRect(x: area.minX * scale, y: area.minY * scale, width: area.width * scale, height: area.height * scale).integral
            .intersection(CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
        let step = cg.bitsPerPixel / 8
        func luma(_ x: Int, _ y: Int) -> Int {
            let at = y * cg.bytesPerRow + x * step
            return (Int(bytes[at]) * 299 + Int(bytes[at + 1]) * 587 + Int(bytes[at + 2]) * 114) / 1000
        }
        var count = 0
        for y in Int(pixels.minY)..<(Int(pixels.maxY) - 2) {
            for x in Int(pixels.minX)..<(Int(pixels.maxX) - 2) {
                let here = luma(x, y)
                if abs(luma(x + 2, y) - here) > 40 || abs(luma(x, y + 2) - here) > 40 { count += 1 }
            }
        }
        return count
    }

    /// Scrolled up a screen and more, desktop's way back shows at the
    /// foot, above the composer; a tap goes to the newest message and the
    /// button goes. While the agent works it shimmers.
    func testJumpToLatest() {
        openConversation()
        XCTAssertFalse(jump.exists, "the way back showed at the newest message")
        scrollUp(2)
        XCTAssertTrue(jump.waitForExistence(timeout: 3), "no way back after scrolling up")
        let card = element("stem-input")
        XCTAssertLessThan(jump.frame.maxY, card.frame.minY, "the way back is not above the composer")
        XCTAssertEqual(jump.frame.midX, app.frame.midX, accuracy: 1, "the way back is not centred")
        XCTAssertEqual(jump.value as? String, "idle")
        pause(1)
        capture("jump-shown")
        jump.tap()
        pause(1.5)
        XCTAssertFalse(jump.exists, "the way back stayed at the newest message")
        capture("jump-tapped")

        // Working: scrolled away, it shimmers.
        composer.tap()
        composer.typeText("Run `sleep 20` with your shell tool, one call, then just say done.")
        app.buttons["Send"].tap()
        XCTAssertTrue(working.waitForExistence(timeout: 15), "the agent never started")
        app.swipeDown(velocity: .slow)
        pause(1)
        scrollUp(2)
        XCTAssertTrue(jump.waitForExistence(timeout: 3))
        XCTAssertEqual(jump.value as? String, "working", "the way back doesn't shimmer while the agent works")
        pause(2.5)
        capture("jump-working")
        let deadline = Date().addingTimeInterval(120)
        while Date() < deadline, working.exists { pause(1) }
        pause(1)
        XCTAssertEqual(jump.value as? String, "idle", "the way back still shimmers after the turn")
        jump.tap()
        pause(1.5)
        XCTAssertFalse(jump.exists)
    }

    /// A picture opened whole; a swipe to the side shows the next and the
    /// one before, in the conversation's order; a drag down that's let go
    /// short comes back, and one far enough closes it.
    func testPictureViewer() {
        openConversation()
        let count = pictures.count
        XCTAssertGreaterThanOrEqual(count, 4)
        // The second newest, so there is one after it and ones before.
        let picture = pictures.element(boundBy: count - 2)
        for _ in 0..<12 where picture.frame.midY < app.frame.height * 0.2 || picture.frame.midY > app.frame.height * 0.6 {
            let up = picture.frame.midY < app.frame.height * 0.2
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: up ? 0.3 : 0.6)).press(
                forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: up ? 0.55 : 0.35)),
                withVelocity: .slow, thenHoldForDuration: 0.3
            )
            pause(0.6)
        }
        let loaded = NSPredicate(format: "value == %@", "loaded")
        expectation(for: loaded, evaluatedWith: picture)
        waitForExpectations(timeout: 60)
        picture.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        let viewer = app.images["stem-picture-viewer"]
        XCTAssertTrue(viewer.waitForExistence(timeout: 5))
        pause(1.5)
        let first = viewer.value as? String ?? ""
        let parts = first.components(separatedBy: " of ")
        XCTAssertEqual(parts.count, 2, "the viewer doesn't say where it is: \(first)")
        let total = Int(parts.last ?? "") ?? 0
        let index = Int(parts.first ?? "") ?? 0
        XCTAssertEqual(total, count, "the viewer pages through \(total) pictures, the conversation has \(count)")
        XCTAssertEqual(index, count - 1)
        capture("viewer-open")

        app.swipeLeft()
        pause(1.2)
        XCTAssertEqual(viewer.value as? String, "\(count) of \(count)", "a swipe left didn't show the next")
        capture("viewer-next")
        app.swipeLeft()
        pause(1.2)
        XCTAssertEqual(viewer.value as? String, "\(count) of \(count)", "the last went past the end")
        app.swipeRight()
        pause(1)
        app.swipeRight()
        pause(1.2)
        XCTAssertEqual(viewer.value as? String, "\(count - 2) of \(count)", "a swipe right didn't show the one before")
        capture("viewer-previous")

        // Dragged down and held: the picture follows the finger and the
        // ground fades; let go there, it closes.
        let middle = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45))
        middle.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.52)), withVelocity: .slow, thenHoldForDuration: 1.5)
        pause(1)
        XCTAssertTrue(viewer.exists, "a short drag down closed it")
        middle.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75)), withVelocity: .slow, thenHoldForDuration: 1)
        pause(1.5)
        XCTAssertFalse(viewer.exists, "a drag down didn't close it")
        XCTAssertTrue(composer.exists)
        capture("viewer-closed")
    }

    // MARK: Composer

    private var composerText: String { composer.value as? String ?? "" }

    /// Waits for the composer to read `text`.
    private func waitForComposer(_ text: String, timeout: TimeInterval = 10, _ message: String) {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline, composerText != text { pause(0.3) }
        XCTAssertEqual(composerText, text, message)
    }

    /// Clears Happy's draft from the desktop's side, so the composer starts
    /// empty, as a clear made on another device arrives.
    private func clearDraft() {
        print("STEM_STEP draft-clear")
        waitForComposer("", "a draft cleared on the computer stayed on the phone")
    }

    /// The draft as the computer keeps it: typed here, it is there when
    /// the conversation opens again, and after a cold launch; written on
    /// the desktop, it shows here while the conversation is open.
    func testDraftSync() {
        openConversation()
        clearDraft()
        let typed = "Draft typed on the phone"
        composer.tap()
        composer.typeText(typed)
        pause(1)
        capture("draft-typed")
        app.tapBack()
        pause(1.5)
        // The daemon's copy, for the log.
        print("STEM_STEP draft-check")
        let happy = element("stem-row:space:Happy")
        XCTAssertTrue(happy.waitForExistence(timeout: 5))
        happy.tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        waitForComposer(typed, timeout: 5, "the draft didn't come back on reopening")
        capture("draft-reopened")

        app.terminate()
        app.launch()
        let again = element("stem-row:space:Happy")
        XCTAssertTrue(again.waitForExistence(timeout: 20))
        again.tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        waitForComposer(typed, timeout: 5, "the draft didn't survive a cold launch")
        pause(1)

        print("STEM_STEP draft-desktop")
        waitForComposer("Written on the desktop", "the desktop's draft never showed on the phone")
        pause(1)
        capture("draft-from-desktop")
        clearDraft()
    }

    /// Past five lines the composer offers its text full screen: the
    /// button at the text's top right opens it with the same text, and the
    /// one there puts it back with what was typed full screen.
    func testExpandEditor() {
        openConversation()
        clearDraft()
        let expand = app.buttons["composer-expand"]
        composer.tap()
        composer.typeText("One\nTwo\nThree\nFour\nFive")
        pause(0.8)
        XCTAssertFalse(expand.exists, "five lines offered the full-screen editor")
        composer.typeText("\nSix\nSeven\nEight")
        XCTAssertTrue(expand.waitForExistence(timeout: 3), "no expand button past five lines")
        let card = element("stem-input")
        XCTAssertEqual(expand.frame.maxX, card.frame.maxX - 18, accuracy: 1.5, "the expand button isn't at the text's right")
        XCTAssertLessThan(expand.frame.minY - card.frame.minY, 30, "the expand button isn't at the text's top")
        capture("expand-offered")

        expand.tap()
        let editor = app.textViews["composer-editor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 3), "the full-screen editor never opened")
        pause(0.8)
        XCTAssertEqual(editor.value as? String, "One\nTwo\nThree\nFour\nFive\nSix\nSeven\nEight")
        XCTAssertGreaterThan(editor.frame.height, app.frame.height * 0.3, "the editor isn't full screen")
        // XCUITest's hasFocus reads false for either text view once a
        // screen has been presented over the chat: typing is the proof.
        XCTAssertTrue(app.keyboards.firstMatch.exists, "the keyboard went down")
        capture("expand-editor")
        // The caret is where it was in the card: at the end.
        editor.typeText("\nNine, typed full screen")
        pause(0.5)
        capture("expand-editor-typed")
        app.buttons["composer-collapse"].tap()
        pause(1)
        XCTAssertFalse(editor.exists)
        XCTAssertEqual(composerText, "One\nTwo\nThree\nFour\nFive\nSix\nSeven\nEight\nNine, typed full screen")
        XCTAssertTrue(app.keyboards.firstMatch.exists, "the keyboard went down on collapsing")
        composer.typeText(" and after")
        XCTAssertTrue(composerText.hasSuffix("full screen and after"), "the caret didn't come back where it was left")
        capture("expand-collapsed")

        // A draft written on the desktop while the text is full screen
        // shows there, and goes back to the card with it.
        expand.tap()
        XCTAssertTrue(editor.waitForExistence(timeout: 3))
        pause(1.5)
        print("STEM_STEP draft-desktop")
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline, editor.value as? String != "Written on the desktop" { pause(0.3) }
        XCTAssertEqual(editor.value as? String, "Written on the desktop", "the desktop's draft didn't reach the full-screen editor")
        capture("expand-editor-desktop")
        app.buttons["composer-collapse"].tap()
        pause(1)
        XCTAssertEqual(composerText, "Written on the desktop", "collapsing put back an older text")
        clearDraft()
    }

    /// Steering sent while the agent works waits under the working line,
    /// as next in line, dimmed; when the agent takes it up it goes into
    /// the transcript above the line.
    func testSteeringWaitsUnderTheWorkingLine() {
        openConversation()
        clearDraft()
        composer.tap()
        composer.typeText("Run `sleep 25` with your shell tool, one call, then say only: first done.")
        app.buttons["Send"].tap()
        XCTAssertTrue(working.waitForExistence(timeout: 20), "the agent never started")
        pause(3)
        composer.typeText("Then say only: steering taken (STEER-\(Int(Date().timeIntervalSince1970) % 1000))")
        let token = composerText.components(separatedBy: "(").last?.dropLast() ?? ""
        app.buttons["Send"].tap()
        let steer = app.descendants(matching: .any).matching(identifier: "stem-message").matching(NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", "Then say only", String(token))).firstMatch
        XCTAssertTrue(steer.waitForExistence(timeout: 5), "the steering never showed")
        pause(1)
        XCTAssertTrue(working.exists, "the turn ended before the steering could wait")
        XCTAssertGreaterThanOrEqual(steer.frame.minY, working.frame.maxY - 1, "waiting steering isn't under the working line")
        print("STEM_FRAMES queued working=\(working.frame) steer=\(steer.frame)")
        capture("steering-queued")

        let deadline = Date().addingTimeInterval(180)
        while Date() < deadline, working.exists, steer.frame.minY >= working.frame.maxY - 1 { pause(0.5) }
        pause(1.5)
        if working.exists {
            XCTAssertLessThanOrEqual(steer.frame.maxY, working.frame.minY + 1, "taken steering isn't above the working line")
            print("STEM_FRAMES taken working=\(working.frame) steer=\(steer.frame)")
        }
        capture("steering-taken")
        while Date() < deadline, working.exists { pause(1) }
        pause(1)
        let reply = app.descendants(matching: .any).matching(identifier: "stem-message").matching(NSPredicate(format: "label CONTAINS[c] %@", "steering taken")).allElementsBoundByIndex
        XCTAssertTrue(reply.contains { $0.frame.minY > steer.frame.maxY - 1 && !$0.label.contains("Then say only") }, "the agent's answer to the steering isn't under it")
        capture("steering-answered")
    }
}
