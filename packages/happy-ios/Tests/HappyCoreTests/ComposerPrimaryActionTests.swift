import HappyCore
import XCTest

/// agentInputPrimaryAction.test.ts.
final class ComposerPrimaryActionTests: XCTestCase {
    private func resolve(
        hasComposerContent: Bool = false,
        isSendBlocked: Bool = false,
        isSendDisabled: Bool = false,
        showAbortButton: Bool = false,
        canAbort: Bool = true,
        canVoice: Bool = false
    ) -> AgentInputPrimaryAction {
        AgentInputPrimaryAction.resolve(
            hasComposerContent: hasComposerContent,
            isSendBlocked: isSendBlocked,
            isSendDisabled: isSendDisabled,
            showAbortButton: showAbortButton,
            canAbort: canAbort,
            canVoice: canVoice
        )
    }

    func testStopForABlankComposerWhileTheAgentThinks() {
        XCTAssertEqual(resolve(showAbortButton: true), .stop)
    }

    func testSendAsSoonAsAFollowUpHasContent() {
        XCTAssertEqual(resolve(hasComposerContent: true, showAbortButton: true), .send)
    }

    func testNoStopWithoutAnAbortHandler() {
        XCTAssertEqual(resolve(showAbortButton: true, canAbort: false), .idle)
    }

    func testAnEmptyIdleComposerIsInactive() {
        XCTAssertEqual(resolve(), .idle)
    }

    func testVoiceOnAnEmptyComposerWhenDictationIsAvailable() {
        XCTAssertEqual(resolve(canVoice: true), .voice)
    }

    func testStopAheadOfVoiceWhileThinking() {
        XCTAssertEqual(resolve(showAbortButton: true, canVoice: true), .stop)
    }

    func testSendAheadOfVoiceWithContent() {
        XCTAssertEqual(resolve(hasComposerContent: true, canVoice: true), .send)
    }

    func testStopForABlankComposerWhenSteeringIsBlocked() {
        XCTAssertEqual(resolve(isSendBlocked: true, showAbortButton: true, canVoice: true), .stop)
    }

    func testBlockedSendForContent() {
        XCTAssertEqual(resolve(hasComposerContent: true, isSendBlocked: true, showAbortButton: true), .blocked)
    }
}
