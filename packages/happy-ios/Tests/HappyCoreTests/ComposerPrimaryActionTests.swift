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
        canVoice: Bool = false,
        canRecord: Bool = false
    ) -> AgentInputPrimaryAction {
        AgentInputPrimaryAction.resolve(
            hasComposerContent: hasComposerContent,
            isSendBlocked: isSendBlocked,
            isSendDisabled: isSendDisabled,
            showAbortButton: showAbortButton,
            canAbort: canAbort,
            canVoice: canVoice,
            canRecord: canRecord
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

    // The microphone (`RecordButton`) holds send's place while there is
    // nothing to send, as Telegram's does; Stop and send come first.

    func testTheMicrophoneOnAnEmptyComposer() {
        XCTAssertEqual(resolve(canRecord: true), .record)
    }

    func testSendAsSoonAsThereIsSomethingToSendInsteadOfTheMicrophone() {
        XCTAssertEqual(resolve(hasComposerContent: true, canRecord: true), .send)
    }

    func testStopAheadOfTheMicrophoneWhileTheAgentWorks() {
        XCTAssertEqual(resolve(showAbortButton: true, canRecord: true), .stop)
    }

    func testNoMicrophoneWhileSendingIsOff() {
        XCTAssertEqual(resolve(isSendDisabled: true, canRecord: true), .idle)
    }
}
