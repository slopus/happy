import ObjectiveC
import UIKit
import XCTest

/// The transcript and the working line never idle for XCUITest's wait
/// around every action; as UITests does, the private wait goes.
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

/// Reading a V2 conversation against a real throwaway Happy Agent:
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
        app.launch()
    }

    /// The computer's Theme in its settings, gone round to `name`
    /// ("Light", "Dark", "Adaptive"), then back to the conversation.
    private func theme(_ name: String) {
        app.tapBack()
        pause(1)
        let mark = element("settings-mark")
        XCTAssertTrue(mark.waitForExistence(timeout: 5))
        mark.tap()
        let row = element("settings:theme")
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        for _ in 0..<3 where !row.label.contains(name) {
            row.tap()
            pause(0.8)
        }
        XCTAssertTrue(row.label.contains(name), "the theme never reached \(name)")
        app.buttons["glass-back"].firstMatch.tap()
        pause(1)
        let happy = happyRow
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

    private var composer: XCUIElement { app.textViews["composer"] }
    /// Happy's own conversation: its space, or, on the shared sidebar, its
    /// Chief of Staff under Bots.
    private var happyRow: XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ OR identifier ENDSWITH %@", "row:space:Happy", ":Chief of Staff")).firstMatch
    }
    private var working: XCUIElement { element("working") }
    private var jump: XCUIElement { app.buttons["jump-latest"] }
    private var pictures: XCUIElementQuery {
        app.descendants(matching: .any).matching(identifier: "media").matching(NSPredicate(format: "label ENDSWITH %@", ".png"))
    }

    /// Pairs if this simulator has no computer yet, then opens Happy's
    /// conversation, asking the agent for four pictures and a long answer
    /// the first time.
    private func openConversation() {
        let any = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "row:")).firstMatch
        if !any.waitForExistence(timeout: 8) {
            print("HAPPY_PAIR_READY")
            let match = app.buttons["Emoji match"]
            XCTAssertTrue(match.waitForExistence(timeout: 120), "pairing never showed its emoji")
            pause(1.5)
            match.tap()
            XCTAssertTrue(any.waitForExistence(timeout: 90))
        }
        pause(1)
        let happy = happyRow
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

    /// Dark, with the agent working: the ground between the working line
    /// and the composer is the transcript's own, at rest and pulled so the
    /// working line goes under the card, never a lighter band over the end
    /// of the transcript (build 45 drew one whenever content went under).
    func testNoBandAboveTheComposerWhileWorking() {
        openConversation()
        theme("Dark")
        composer.tap()
        composer.typeText("Run `sleep 20` with your shell tool, one call, then just say done.")
        app.buttons["Send"].tap()
        XCTAssertTrue(working.waitForExistence(timeout: 15), "the agent never started")
        dismissKeyboard()
        if jump.exists {
            jump.tap()
            pause(1.5)
        }
        let card = element("input").frame
        func check(_ name: String) {
            let shot = XCUIScreen.main.screenshot().image
            capture("band-\(name)")
            // The 10 at either side, outside every bubble and line, from 44
            // above the card to it: a band would cross them.
            let sides = [
                CGRect(x: 1, y: card.minY - 44, width: 9, height: 40),
                CGRect(x: app.frame.width - 10, y: card.minY - 44, width: 9, height: 40),
            ]
            let ground = Self.ground(in: shot)
            for side in sides {
                let above = Self.luma(in: shot, area: side)
                print("HAPPY_BAND \(name) ground=\(ground) above=\(above)")
                XCTAssertEqual(above, Double(ground), accuracy: 1.5, "\(name): a band above the composer (\(Int(above)) on \(ground))")
            }
        }
        check("rest")
        // Pulled a little and held: the working line under the card.
        for (index, drag) in [0.04, 0.08].enumerated() {
            let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4))
            start.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4 + drag)), withVelocity: .slow, thenHoldForDuration: 1.2)
            pause(0.6)
            check("pulled-\(index)")
        }
        XCTAssertTrue(working.waitForNonExistence(timeout: 60))
        pause(1)
        check("idle")
        theme("Adaptive")
    }

    /// The edges are a blur and nothing else, at the header and at the
    /// composer, light and dark: with nothing under them (a short
    /// conversation at rest) and with the transcript under them, their
    /// ground is the screen's own, never a lighter or darker band.
    func testEdgesKeepTheGround() {
        openConversation()
        for name in ["Light", "Dark"] {
            theme(name)
            // The transcript under both edges.
            scrollUp(1)
            pause(1.5)
            checkEdges("\(name)-under")
            app.tapBack()
            pause(1)
            openShortConversation()
            checkEdges("\(name)-nothing")
            app.tapBack()
            pause(1)
            XCTAssertTrue(happyRow.waitForExistence(timeout: 5))
            happyRow.tap()
            XCTAssertTrue(composer.waitForExistence(timeout: 5))
            pause(1.5)
        }
        theme("Adaptive")
    }

    /// At the sides above the composer, beside it and under it: the ground.
    /// With nothing under the header, its edge below the controls is too,
    /// but for their own shadow on white.
    private func checkEdges(_ name: String) {
        let shot = XCUIScreen.main.screenshot().image
        capture("edges-ground-\(name)")
        let ground = Self.ground(in: shot)
        let capsule = element("chat-capsule").frame
        let card = element("input").frame
        var areas: [(String, CGRect)] = [
            ("foot-left", CGRect(x: 1, y: card.minY - 44, width: 9, height: 40)),
            ("foot-right", CGRect(x: app.frame.width - 10, y: card.minY - 44, width: 9, height: 40)),
            // Inside the composer's scrim, under the card at the screen's
            // sides, past the card's own soft shadow.
            ("scrim-left", CGRect(x: 0, y: card.maxY + 12, width: 6, height: app.frame.height - card.maxY - 14)),
            ("scrim-right", CGRect(x: app.frame.width - 6, y: card.maxY + 12, width: 6, height: app.frame.height - card.maxY - 14)),
        ]
        // Under the header the transcript's bubbles run to 8 from the
        // sides, and blurred they spread there: only with nothing under it
        // is the header's edge all ground.
        if name.hasSuffix("nothing") {
            areas += [
                ("head-left", CGRect(x: 1, y: capsule.maxY + 2, width: 9, height: 12)),
                ("head-right", CGRect(x: app.frame.width - 10, y: capsule.maxY + 2, width: 9, height: 12)),
                ("head-across", CGRect(x: 0, y: capsule.maxY + 2, width: app.frame.width, height: 12)),
            ]
        }
        for (place, area) in areas {
            let mean = Self.luma(in: shot, area: area)
            print("HAPPY_GROUND \(name) \(place) ground=\(ground) mean=\(mean)")
            if name.hasPrefix("Light"), place.hasPrefix("head") {
                // The glass controls' own shadow falls here on white (244 under
                // the capsule, 252 at the sides), scrim or none: never lighter.
                XCTAssertLessThanOrEqual(mean, Double(ground) + 1.5, "\(name): the \(place) edge is lighter than the ground")
                XCTAssertGreaterThanOrEqual(mean, Double(ground) - (place == "head-across" ? 9 : 4.5), "\(name): the \(place) edge is darker than the controls' shadow (\(mean) on \(ground))")
            } else {
                XCTAssertEqual(mean, Double(ground), accuracy: 1.5, "\(name): the \(place) edge is not the ground (\(mean) on \(ground))")
            }
        }
    }

    /// The screen's ground: the brightness most of its middle has.
    private static func ground(in image: UIImage) -> Int {
        mostCommonLuma(in: image, area: CGRect(x: 0, y: image.size.height * 0.3, width: image.size.width, height: image.size.height * 0.4))
    }

    /// The keyboard down, dragged away under the finger.
    private func dismissKeyboard() {
        for _ in 0..<3 where app.keyboards.firstMatch.exists {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45)).press(
                forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)),
                withVelocity: .slow, thenHoldForDuration: 0.1
            )
            pause(1)
        }
        XCTAssertFalse(app.keyboards.firstMatch.exists, "the keyboard stayed up")
        pause(1)
    }

    /// The brightness most of `area` (in points) has: a screen's ground.
    private static func mostCommonLuma(in image: UIImage, area: CGRect) -> Int {
        guard let cg = image.cgImage, let data = cg.dataProvider?.data, let bytes = CFDataGetBytePtr(data) else { return -1 }
        let scale = CGFloat(cg.width) / image.size.width
        let pixels = CGRect(x: area.minX * scale, y: area.minY * scale, width: area.width * scale, height: area.height * scale).integral
            .intersection(CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
        let step = cg.bitsPerPixel / 8
        var counts = [Int](repeating: 0, count: 256)
        for y in stride(from: Int(pixels.minY), to: Int(pixels.maxY), by: 2) {
            for x in stride(from: Int(pixels.minX), to: Int(pixels.maxX), by: 2) {
                let at = y * cg.bytesPerRow + x * step
                counts[(Int(bytes[at]) * 299 + Int(bytes[at + 1]) * 587 + Int(bytes[at + 2]) * 114) / 1000] += 1
            }
        }
        return counts.indices.max { counts[$0] < counts[$1] } ?? -1
    }

    /// The edges as Telegram's: mid-transcript, light and dark, what goes
    /// under the status bar has faded into the ground, no stroke left in
    /// it, while what goes behind the composer still reads (strokes at the
    /// card's sides, under its lower half, are sharp).
    func testEdgesFadeLikeTelegram() {
        openConversation()
        let card = element("input")
        XCTAssertTrue(card.exists)
        for name in ["Light", "Dark"] {
            theme(name)
            scrollUp(1)
            pause(1.5)
            let shot = XCUIScreen.main.screenshot()
            capture("telegram-\(name)")
            let frame = card.frame
            // The transcript's own lines, well clear of both edges: sharp.
            let transcript = CGRect(x: 0, y: app.frame.height * 0.35, width: app.frame.width, height: app.frame.height * 0.3)
            let sharp = Self.sharpEdges(in: shot.image, area: transcript)
            XCTAssertGreaterThan(sharp, 500, "\(name): the transcript itself reads as blurred (\(sharp))")
            // Under the status bar, between its time and its icons.
            let top = CGRect(x: app.frame.width * 0.36, y: 2, width: app.frame.width * 0.28, height: 40)
            let topEdges = Self.sharpEdges(in: shot.image, area: top)
            // In the 8 of gutter beside the card's top half, above the foot's fade.
            let beside = CGRect(x: 0, y: frame.minY, width: frame.minX, height: frame.height / 2)
            let besideEdges = Self.sharpEdges(in: shot.image, area: beside)
            print("HAPPY_TELEGRAM \(name) top=\(topEdges) beside=\(besideEdges) transcript=\(sharp)")
            XCTAssertLessThan(topEdges, 20, "\(name): \(topEdges) sharp strokes under the status bar")
        }
        theme("Adaptive")
    }

    /// Flung to the top of a long conversation and of a short one, light
    /// and dark, the ground under the composer holds still: sampled all
    /// through each bounce off the top, its brightness never jumps. (A
    /// short one's end, pulled down past the composer by the bounce, once
    /// brought the scrim in and out again.)
    func testScrollToTopDoesNotFlashUnderTheComposer() {
        openConversation()
        for name in ["Light", "Dark"] {
            theme(name)
            flingToTop("long-\(name)")
            jump.tap()
            pause(1.5)
            app.tapBack()
            pause(1)
            openShortConversation()
            flingToTop("short-\(name)")
            app.tapBack()
            pause(1)
            let happy = happyRow
            XCTAssertTrue(happy.waitForExistence(timeout: 5))
            happy.tap()
            XCTAssertTrue(composer.waitForExistence(timeout: 5))
            pause(1.5)
        }
        theme("Adaptive")
    }

    /// A seeded task, its conversation a prompt and an answer that end a
    /// little above the composer, asked for the first time.
    private func openShortConversation() {
        let row = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "row:", "Try the new recipe")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        row.tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        pause(2)
        let answer = app.descendants(matching: .any).matching(identifier: "message").matching(NSPredicate(format: "label CONTAINS %@ AND NOT (label CONTAINS %@)", "21", "numbers")).firstMatch
        if !answer.exists {
            composer.tap()
            composer.typeText("Write the numbers 1 to 22, one per line, and nothing else. Use no tools.")
            app.buttons["Send"].tap()
            if app.buttons["Continue"].waitForExistence(timeout: 2) { app.buttons["Continue"].tap() }
            XCTAssertTrue(answer.waitForExistence(timeout: 120), "the agent never answered")
            pause(3)
        }
        if composer.hasFocus { app.swipeDown(velocity: .slow) }
        pause(1.5)
    }

    /// Three flings down the screen, each from at or near the top, with
    /// the composer's own ground sampled as fast as screenshots come
    /// through each bounce: beside the card, and under it at the screen's
    /// sides, where no line of the transcript reaches (blurred lines go by
    /// under the middle of it, as on home).
    private func flingToTop(_ name: String) {
        let card = element("input").frame
        let under = CGRect(x: 0, y: card.maxY + 2, width: 4, height: app.frame.height - card.maxY - 4)
        let beside = CGRect(x: 1, y: card.minY + 4, width: max(1, card.minX - 2), height: card.height - 8)
        var samples: [(under: Double, beside: Double)] = []
        for _ in 0..<3 {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).press(
                forDuration: 0.02, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75)),
                withVelocity: .fast, thenHoldForDuration: 0
            )
            for _ in 0..<10 {
                let shot = XCUIScreen.main.screenshot().image
                samples.append((Self.luma(in: shot, area: under), Self.luma(in: shot, area: beside)))
            }
        }
        capture("top-\(name)")
        let unders = samples.map(\.under), besides = samples.map(\.beside)
        print("HAPPY_FLASH \(name) under=\(unders.map { Int($0) }) beside=\(besides.map { Int($0) })")
        XCTAssertLessThan((unders.max() ?? 0) - (unders.min() ?? 0), 4, "\(name): the ground under the composer flashed")
        XCTAssertLessThan((besides.max() ?? 0) - (besides.min() ?? 0), 4, "\(name): the ground beside the composer flashed")
    }

    /// The mean brightness of `area` (in points), 0 to 255.
    private static func luma(in image: UIImage, area: CGRect) -> Double {
        guard let cg = image.cgImage, let data = cg.dataProvider?.data, let bytes = CFDataGetBytePtr(data) else { return -1 }
        let scale = CGFloat(cg.width) / image.size.width
        let pixels = CGRect(x: area.minX * scale, y: area.minY * scale, width: area.width * scale, height: area.height * scale).integral
            .intersection(CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
        let step = cg.bitsPerPixel / 8
        var sum = 0, count = 0
        for y in stride(from: Int(pixels.minY), to: Int(pixels.maxY), by: 2) {
            for x in stride(from: Int(pixels.minX), to: Int(pixels.maxX), by: 2) {
                let at = y * cg.bytesPerRow + x * step
                sum += (Int(bytes[at]) * 299 + Int(bytes[at + 1]) * 587 + Int(bytes[at + 2]) * 114) / 1000
                count += 1
            }
        }
        return count == 0 ? -1 : Double(sum) / Double(count)
    }

    /// The chat's edges beside home's, light and dark. Beside the composer
    /// and under it to the screen's foot, the chat at its newest is home's
    /// list at its end, pixel for pixel: the same scrim, frame and strength
    /// over the same nothing. Then each scrolled so its content runs under
    /// the glass header and under the composer, pictures for the eye
    /// (`edges-*`); what shows there is checked by
    /// `testEdgesFadeLikeTelegram`.
    func testEdgesLikeHome() {
        openConversation()
        for name in ["Light", "Dark"] {
            theme(name)
            // At the newest, the transcript runs on under the header.
            let chatRest = XCUIScreen.main.screenshot().image
            capture("edges-chat-newest-\(name)")
            let card = element("input").frame
            app.tapBack()
            pause(1.5)
            for _ in 0..<3 { app.swipeUp(velocity: .fast) }
            pause(2.5)
            let homeRest = XCUIScreen.main.screenshot().image
            capture("edges-home-end-\(name)")
            let around = [
                CGRect(x: 0, y: card.minY, width: card.minX - 1, height: card.height),
                CGRect(x: card.maxX + 1, y: card.minY, width: app.frame.width - card.maxX - 1, height: card.height),
                CGRect(x: 0, y: card.maxY + 1, width: app.frame.width, height: app.frame.height - card.maxY - 1),
            ]
            let diff = Self.difference(chatRest, homeRest, areas: around)
            print("HAPPY_HOME_DIFF \(name) mean=\(diff.mean) max=\(diff.max)")
            XCTAssertLessThan(diff.mean, 1, "\(name): the chat's composer edge is not home's")
            for _ in 0..<3 { app.swipeDown(velocity: .fast) }
            pause(1.5)
            XCTAssertTrue(happyRow.waitForExistence(timeout: 5))
            happyRow.tap()
            XCTAssertTrue(composer.waitForExistence(timeout: 5))
            pause(2)
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
            let happy = happyRow
            XCTAssertTrue(happy.waitForExistence(timeout: 5))
            happy.tap()
            XCTAssertTrue(composer.waitForExistence(timeout: 5))
            pause(2)
        }
        theme("Adaptive")
    }

    /// How far apart two screenshots are over `areas` (in points): the mean
    /// and largest step of any channel, 0 to 255.
    private static func difference(_ a: UIImage, _ b: UIImage, areas: [CGRect]) -> (mean: Double, max: Int) {
        guard let ca = a.cgImage, let cb = b.cgImage, ca.width == cb.width, ca.height == cb.height, ca.bitsPerPixel == cb.bitsPerPixel,
              let da = ca.dataProvider?.data, let db = cb.dataProvider?.data,
              let pa = CFDataGetBytePtr(da), let pb = CFDataGetBytePtr(db) else { return (255, 255) }
        let scale = CGFloat(ca.width) / a.size.width
        let step = ca.bitsPerPixel / 8
        var sum = 0, count = 0, largest = 0
        for area in areas {
            let pixels = CGRect(x: area.minX * scale, y: area.minY * scale, width: area.width * scale, height: area.height * scale).integral
                .intersection(CGRect(x: 0, y: 0, width: ca.width, height: ca.height))
            guard !pixels.isNull else { continue }
            for y in Int(pixels.minY)..<Int(pixels.maxY) {
                for x in Int(pixels.minX)..<Int(pixels.maxX) {
                    for channel in 0..<3 {
                        let d = abs(Int(pa[y * ca.bytesPerRow + x * step + channel]) - Int(pb[y * cb.bytesPerRow + x * step + channel]))
                        sum += d
                        largest = max(largest, d)
                    }
                    count += 3
                }
            }
        }
        return (count == 0 ? 255 : Double(sum) / Double(count), largest)
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
        let card = element("input")
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
        let viewer = app.images["picture-viewer"]
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
        print("HAPPY_STEP draft-clear")
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
        print("HAPPY_STEP draft-check")
        let happy = happyRow
        XCTAssertTrue(happy.waitForExistence(timeout: 5))
        happy.tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        waitForComposer(typed, timeout: 5, "the draft didn't come back on reopening")
        capture("draft-reopened")

        app.terminate()
        app.launch()
        let again = happyRow
        XCTAssertTrue(again.waitForExistence(timeout: 20))
        again.tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        waitForComposer(typed, timeout: 5, "the draft didn't survive a cold launch")
        pause(1)

        print("HAPPY_STEP draft-desktop")
        waitForComposer("Written on the desktop", "the desktop's draft never showed on the phone")
        pause(1)
        capture("draft-from-desktop")
        clearDraft()
    }

    /// Past five lines the composer offers its text full screen: the
    /// button at the text's top right opens it with the same text, and the
    /// one there puts it back with what was typed full screen.
    /// The expand button is send's, in send's column: its size and centre,
    /// as far in from the card's top as send is from its foot.
    private func assertExpandOverSend() {
        let card = element("input").frame
        let expand = app.buttons["composer-expand"].frame
        let send = app.buttons["Send"].frame
        XCTAssertEqual(expand.midX, send.midX, accuracy: 1, "the expand button isn't over send")
        XCTAssertEqual(expand.width, send.width, accuracy: 1, "the expand button isn't send's size")
        XCTAssertEqual(expand.minY - card.minY, card.maxY - send.maxY, accuracy: 1, "the expand button isn't in from the top as send is from the foot")
    }

    /// The expand button beside the long text, light and dark, for the eye.
    func testExpandButtonLooks() {
        openConversation()
        // Both themes' pictures, whatever the first shows.
        continueAfterFailure = true
        for name in ["Light", "Dark"] {
            theme(name)
            clearDraft()
            composer.tap()
            composer.typeText("One\nTwo\nThree\nFour\nFive\nSix\nSeven\nEight is a longer line that wraps under the button")
            XCTAssertTrue(app.buttons["composer-expand"].waitForExistence(timeout: 3))
            pause(0.8)
            capture("expand-\(name)")
            assertExpandOverSend()
            clearDraft()
            dismissKeyboard()
        }
        theme("Adaptive")
    }

    /// The expand button appears where it stands. A conversation opened
    /// with a long draft lays its card out inside the opening's animation,
    /// which once carried the button in from the card's corner: the frames
    /// of that opening, as fast as screenshots come, are kept for the eye,
    /// and it ends over send.
    func testExpandAppearsInPlace() {
        openConversation()
        clearDraft()
        composer.tap()
        composer.typeText("One\nTwo\nThree\nFour\nFive\nSix")
        XCTAssertTrue(app.buttons["composer-expand"].waitForExistence(timeout: 3))
        pause(1.5)
        app.tapBack()
        pause(1.5)
        XCTAssertTrue(happyRow.waitForExistence(timeout: 5))
        happyRow.tap()
        var shots: [UIImage] = []
        let start = Date()
        while Date().timeIntervalSince(start) < 1.2 { shots.append(XCUIScreen.main.screenshot().image) }
        for (index, shot) in shots.enumerated() {
            let attachment = XCTAttachment(image: shot)
            attachment.name = "expand-open-\(index)"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
        XCTAssertTrue(app.buttons["composer-expand"].waitForExistence(timeout: 3))
        assertExpandOverSend()
        clearDraft()
    }

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
        assertExpandOverSend()
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
        print("HAPPY_STEP draft-desktop")
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
        let steer = app.descendants(matching: .any).matching(identifier: "message").matching(NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", "Then say only", String(token))).firstMatch
        XCTAssertTrue(steer.waitForExistence(timeout: 5), "the steering never showed")
        pause(1)
        XCTAssertTrue(working.exists, "the turn ended before the steering could wait")
        XCTAssertGreaterThanOrEqual(steer.frame.minY, working.frame.maxY - 1, "waiting steering isn't under the working line")
        print("HAPPY_FRAMES queued working=\(working.frame) steer=\(steer.frame)")
        capture("steering-queued")

        let deadline = Date().addingTimeInterval(180)
        while Date() < deadline, working.exists, steer.frame.minY >= working.frame.maxY - 1 { pause(0.5) }
        pause(1.5)
        if working.exists {
            XCTAssertLessThanOrEqual(steer.frame.maxY, working.frame.minY + 1, "taken steering isn't above the working line")
            print("HAPPY_FRAMES taken working=\(working.frame) steer=\(steer.frame)")
        }
        capture("steering-taken")
        while Date() < deadline, working.exists { pause(1) }
        pause(1)
        let reply = app.descendants(matching: .any).matching(identifier: "message").matching(NSPredicate(format: "label CONTAINS[c] %@", "steering taken")).allElementsBoundByIndex
        XCTAssertTrue(reply.contains { $0.frame.minY > steer.frame.maxY - 1 && !$0.label.contains("Then say only") }, "the agent's answer to the steering isn't under it")
        capture("steering-answered")
    }
}
