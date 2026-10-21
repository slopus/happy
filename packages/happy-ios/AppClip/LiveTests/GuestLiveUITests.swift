import XCTest

/// Opt-in integration against the separately running real invitation bridge.
/// Install and invoke the Clip before running this scheme. No capability is
/// compiled into this test or product.
final class GuestLiveUITests: XCTestCase {
    @MainActor func testNamedMemberAda() throws { try joinAndChat(name: "Ada Lovelace") }
    @MainActor func testNamedMemberGrace() throws { try joinAndChat(name: "Grace Hopper") }
    @MainActor func testGroupMemberAda() throws { try joinAndChat(name: "Ada Lovelace", apiOrigin: nil) }
    @MainActor func testGroupMemberGraceSeesEarlierHistory() throws {
        try joinAndChat(name: "Grace Hopper", apiOrigin: nil, earlierMember: "Ada Lovelace")
    }
    @MainActor func testGroupAdaSeesGraceAsAnotherMember() throws {
        continueAfterFailure = false
        let clip = XCUIApplication(bundleIdentifier: "com.slopus.happy.botclip.dev.Clip")
        clip.activate()
        XCTAssertTrue(clip.textFields["guest.message"].waitForExistence(timeout: 15))
        XCTAssertEqual(clip.textFields["guest.message"].placeholderValue, "Message as Ada Lovelace")
        let other = NSPredicate(format: "value CONTAINS %@", "Grace Hopper\nReply with exactly: Hello Grace Hopper.")
        expectation(for: other, evaluatedWith: clip.textViews.firstMatch)
        waitForExpectations(timeout: 35)
        let mine = NSPredicate(format: "value CONTAINS %@", "You\nReply with exactly: Hello Ada Lovelace.")
        expectation(for: mine, evaluatedWith: clip.textViews.firstMatch)
        waitForExpectations(timeout: 10)
        attach(clip, name: "Actual App Clip · Preview · shared group with another member's name")
    }

    @MainActor func testExistingAdaSkipsOnboardingOnReopenAndRestart() throws {
        continueAfterFailure = false
        let clip = XCUIApplication(bundleIdentifier: "com.slopus.happy.botclip.dev.Clip")
        clip.activate()
        let field = clip.textFields["guest.message"]
        XCTAssertTrue(field.waitForExistence(timeout: 15))
        XCTAssertEqual(field.placeholderValue, "Message as Ada Lovelace")
        XCTAssertFalse(clip.textFields["guest.name"].exists)
        let reply = NSPredicate(format: "value CONTAINS %@", "\nHello Ada Lovelace.")
        expectation(for: reply, evaluatedWith: clip.textViews.firstMatch)
        waitForExpectations(timeout: 35)
        clip.terminate()
        clip.launchEnvironment = ["HAPPY_GUEST_API_ORIGIN": "http://127.0.0.1:17892"]
        clip.launch()
        XCTAssertTrue(field.waitForExistence(timeout: 15))
        XCTAssertEqual(field.placeholderValue, "Message as Ada Lovelace")
        XCTAssertFalse(clip.textFields["guest.name"].exists)
        expectation(for: reply, evaluatedWith: clip.textViews.firstMatch)
        waitForExpectations(timeout: 35)
        attach(clip, name: "Actual App Clip · simulator · existing member resumes without onboarding")
    }

    @MainActor func testInviteHasNoFreeSeats() throws {
        continueAfterFailure = false
        let clip = XCUIApplication(bundleIdentifier: "com.slopus.happy.botclip.dev.Clip")
        clip.activate()
        let name = clip.textFields["guest.name"]
        XCTAssertTrue(name.waitForExistence(timeout: 15))
        name.tap(); name.typeText("Katherine Johnson")
        clip.buttons["guest.join"].tap()
        XCTAssertTrue(clip.staticTexts["This invite is full. There are no free seats."].waitForExistence(timeout: 20))
        XCTAssertFalse(clip.textFields["guest.name"].exists)
        XCTAssertFalse(clip.buttons["guest.send"].exists)
        attach(clip, name: "Actual App Clip · simulator · invitation has no free seats")
    }

    @MainActor private func joinAndChat(name: String, apiOrigin: String? = "http://127.0.0.1:17892", earlierMember: String? = nil) throws {
        continueAfterFailure = false
        let clip = XCUIApplication(bundleIdentifier: "com.slopus.happy.botclip.dev.Clip")
        clip.activate()
        let nameField = clip.textFields["guest.name"]
        XCTAssertTrue(nameField.waitForExistence(timeout: 15))
        XCTAssertTrue(clip.buttons["guest.join"].exists)
        XCTAssertFalse(clip.textFields["guest.message"].exists)
        attach(clip, name: "Actual App Clip · simulator · one-screen name onboarding")
        nameField.tap(); nameField.typeText(name)
        clip.buttons["guest.join"].tap()
        let field = clip.textFields["guest.message"]
        XCTAssertTrue(field.waitForExistence(timeout: 30))
        XCTAssertEqual(field.placeholderValue, "Message as \(name)")
        XCTAssertFalse(nameField.exists)
        if let earlierMember {
            let earlier = NSPredicate(format: "value CONTAINS %@", earlierMember + "\nReply with exactly: Hello " + earlierMember + ".")
            expectation(for: earlier, evaluatedWith: clip.textViews.firstMatch)
            waitForExpectations(timeout: 35)
        }
        field.tap()
        let replyText = "Hello \(name). \(UUID().uuidString.prefix(8))"
        field.typeText("Reply with exactly: \(replyText)")
        let keyboard = clip.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
        let send = clip.buttons["guest.send"]
        XCTAssertLessThanOrEqual(send.frame.maxY, keyboard.frame.minY + 1)
        send.tap()
        let reply = NSPredicate(format: "value CONTAINS %@", "\n" + replyText)
        expectation(for: reply, evaluatedWith: clip.textViews.firstMatch)
        waitForExpectations(timeout: 120)
        attach(clip, name: "Actual App Clip · simulator · \(name) private real bot reply")
        clip.terminate()
        clip.launchEnvironment = apiOrigin.map { ["HAPPY_GUEST_API_ORIGIN": $0] } ?? [:]
        clip.launch()
        XCTAssertTrue(field.waitForExistence(timeout: 15))
        XCTAssertEqual(field.placeholderValue, "Message as \(name)")
        XCTAssertFalse(nameField.exists)
        expectation(for: reply, evaluatedWith: clip.textViews.firstMatch)
        waitForExpectations(timeout: 35)
        attach(clip, name: "Actual App Clip · simulator · \(name) restored without onboarding")
    }

    @MainActor private func attach(_ clip: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: clip.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    @MainActor func testLiveClipRoundTripKeyboardAndSessionRestore() throws {
        continueAfterFailure = false
        let clip = XCUIApplication(bundleIdentifier: "com.slopus.happy.botclip.dev.Clip")
        clip.activate()
        XCTAssertTrue(clip.staticTexts["App Clip live demo"].waitForExistence(timeout: 30))
        let field = clip.textFields["guest.message"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        let replyText = "Hello from the live Happy bot. \(UUID().uuidString.prefix(8))"
        field.typeText("Reply with exactly: \(replyText)")
        let keyboard = clip.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
        let send = clip.buttons["guest.send"]
        XCTAssertLessThanOrEqual(send.frame.maxY, keyboard.frame.minY + 1)
        let keyboardProof = XCTAttachment(screenshot: clip.screenshot())
        keyboardProof.name = "Actual App Clip · simulator · send above keyboard"
        keyboardProof.lifetime = .keepAlways
        add(keyboardProof)
        send.tap()
        let transcript = clip.textViews.firstMatch
        let reply = NSPredicate(format: "value CONTAINS %@", "App Clip live demo\n" + replyText)
        expectation(for: reply, evaluatedWith: transcript)
        waitForExpectations(timeout: 120)
        let first = XCTAttachment(screenshot: clip.screenshot())
        first.name = "Actual App Clip · simulator · real bot reply"
        first.lifetime = .keepAlways
        add(first)

        clip.terminate()
        clip.launchEnvironment = ["HAPPY_GUEST_API_ORIGIN": "http://127.0.0.1:17891"]
        clip.launch()
        XCTAssertTrue(clip.staticTexts["App Clip live demo"].waitForExistence(timeout: 15))
        expectation(for: reply, evaluatedWith: clip.textViews.firstMatch)
        waitForExpectations(timeout: 35)
        let restored = XCTAttachment(screenshot: clip.screenshot())
        restored.name = "Actual App Clip · simulator · restored secure session"
        restored.lifetime = .keepAlways
        add(restored)
    }
}