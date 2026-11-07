import XCTest
@testable import HappyCore

final class DictationTranscriptTests: XCTestCase {
    // MARK: SpeechAnalyzer

    /// Each pause settles a sentence; the next one's reading starts empty.
    func testAnalyzerKeepsEverySentenceAcrossPauses() {
        var transcript = DictationTranscript()
        transcript.revise("Please open")
        transcript.revise("Please open the settings.")
        transcript.finalize("Please open the settings.")
        transcript.revise(" Then")
        XCTAssertEqual(transcript.finalized, "Please open the settings.")
        XCTAssertEqual(transcript.volatile, "Then")
        transcript.revise(" Then check the server.")
        transcript.finalize(" Then check the server.")
        transcript.revise(" Finally")
        transcript.finalize(" Finally, send it.")
        XCTAssertEqual(transcript.finalized, "Please open the settings. Then check the server. Finally, send it.")
        XCTAssertEqual(transcript.volatile, "")
    }

    /// A revision replaces the tail; the final reading wins over every guess.
    func testAnalyzerRevisionReplacesTheTail() {
        var transcript = DictationTranscript()
        transcript.finalize("Write a poem.")
        transcript.revise("short hay")
        transcript.revise("short haiku about")
        XCTAssertEqual(transcript.text, "Write a poem. short haiku about")
        transcript.finalize("Short haiku about the sea.")
        XCTAssertEqual(transcript.text, "Write a poem. Short haiku about the sea.")
    }

    /// Stopped mid-sentence: the reading still volatile at the stop is
    /// settled by the final result that comes after it.
    func testAnalyzerFinalAfterStopSettlesTheTail() {
        var transcript = DictationTranscript()
        transcript.finalize("First.")
        transcript.revise("Turn write")
        XCTAssertEqual(transcript.text, "First. Turn write")
        transcript.finalize("Turn right.")
        XCTAssertEqual(transcript.finalized, "First. Turn right.")
        XCTAssertEqual(transcript.volatile, "")
    }

    // MARK: SFSpeechRecognizer

    /// Kirill's bug: after a pause the reading starts over with the new
    /// sentence. Every sentence stays.
    func testRecognizerKeepsSentencesWhenReadingsStartOver() {
        var transcript = DictationTranscript()
        transcript.update("Please open", audioRange: 0..<1, isFinal: false)
        transcript.update("Please open the settings.", audioRange: 0..<2, isFinal: false)
        transcript.update("Then", audioRange: 5..<5.4, isFinal: false)
        transcript.update("Then check the server.", audioRange: 5..<7, isFinal: false)
        transcript.update("Finally", audioRange: 10..<10.5, isFinal: false)
        XCTAssertEqual(transcript.finalized, "Please open the settings. Then check the server.")
        XCTAssertEqual(transcript.volatile, "Finally")
        transcript.update("Finally, send it.", audioRange: 10..<12, isFinal: true)
        XCTAssertEqual(transcript.finalized, "Please open the settings. Then check the server. Finally, send it.")
        XCTAssertEqual(transcript.volatile, "")
    }

    /// The same, from a recognizer that gives no times with its readings.
    func testRecognizerWithoutTimesKeepsSentencesWhenReadingsStartOver() {
        var transcript = DictationTranscript()
        transcript.update("Please open the settings.", audioRange: nil, isFinal: false)
        transcript.update("Then", audioRange: 0..<0, isFinal: false)
        transcript.update("Then check the server.", audioRange: nil, isFinal: false)
        transcript.update("Done", audioRange: nil, isFinal: true)
        XCTAssertEqual(transcript.text, "Please open the settings. Then check the server. Done")
    }

    /// Revisions over the same audio replace earlier words, never append.
    func testRecognizerRevisionReplacesRatherThanAppends() {
        var transcript = DictationTranscript()
        transcript.update("I scream", audioRange: 0..<1, isFinal: false)
        transcript.update("Ice cream is good", audioRange: 0.1..<2, isFinal: false)
        transcript.update("Ice cream is great.", audioRange: 0.1..<2.1, isFinal: true)
        XCTAssertEqual(transcript.text, "Ice cream is great.")
    }

    func testRecognizerRevisionWithoutTimesReplacesRatherThanAppends() {
        var transcript = DictationTranscript()
        transcript.update("I scream", audioRange: nil, isFinal: false)
        transcript.update("Ice cream", audioRange: nil, isFinal: false)
        transcript.update("Ice cream is great.", audioRange: nil, isFinal: false)
        transcript.update("Ice cream is grey", audioRange: nil, isFinal: false)
        XCTAssertEqual(transcript.text, "Ice cream is grey")
    }

    /// Readings that grow over the same audio don't repeat the start.
    func testRecognizerCumulativeReadingsDoNotDuplicate() {
        var transcript = DictationTranscript()
        transcript.update("Hello", audioRange: 0..<1, isFinal: false)
        transcript.update("Hello again", audioRange: 0..<2, isFinal: false)
        transcript.update("Hello again.", audioRange: 0..<2, isFinal: true)
        XCTAssertEqual(transcript.text, "Hello again.")
    }

    /// A recognizer that keeps the earlier sentence in its reading after a
    /// sentence was settled doesn't get it twice.
    func testRecognizerReadingRepeatingSettledWordsCarriesThemOnce() {
        var transcript = DictationTranscript()
        transcript.update("Please open the settings.", audioRange: nil, isFinal: false)
        transcript.update("Then", audioRange: nil, isFinal: false)
        transcript.update("Please open the settings. Then check", audioRange: nil, isFinal: false)
        XCTAssertEqual(transcript.text, "Please open the settings. Then check")
    }

    /// Stopped mid-sentence: the task's final reading, which comes after
    /// the stop, revises the tail.
    func testRecognizerFinalAfterStopRevisesTheTail() {
        var transcript = DictationTranscript()
        transcript.update("First.", audioRange: 0..<1, isFinal: false)
        transcript.update("Turn write", audioRange: 3..<4, isFinal: false)
        transcript.update("Turn right.", audioRange: 3..<4.2, isFinal: true)
        XCTAssertEqual(transcript.finalized, "First. Turn right.")
        XCTAssertTrue(transcript.volatile.isEmpty)
    }

    /// A new task after the old one ended counts its audio from zero, and a
    /// sentence said twice is kept twice.
    func testRecognizerTaskRolloverKeepsRepeatedWords() {
        var transcript = DictationTranscript()
        transcript.update("Yes.", audioRange: 0..<1, isFinal: true)
        transcript.update("Yes.", audioRange: 0..<1, isFinal: false)
        transcript.update("Yes.", audioRange: 0..<1, isFinal: true)
        XCTAssertEqual(transcript.text, "Yes. Yes.")
    }

    func testRecognizerSentenceSaidAgainInTheSameTaskIsKept() {
        var transcript = DictationTranscript()
        transcript.update("Yes.", audioRange: 0..<1, isFinal: false)
        transcript.update("Yes.", audioRange: 3..<4, isFinal: false)
        XCTAssertEqual(transcript.text, "Yes. Yes.")
    }

    /// An error's empty reading leaves the words.
    func testRecognizerErrorDoesNotEraseWords() {
        var transcript = DictationTranscript()
        transcript.update("Keep these words", audioRange: 0..<2, isFinal: false)
        transcript.update("", audioRange: nil, isFinal: true)
        XCTAssertEqual(transcript.finalized, "Keep these words")
    }

    /// DictationTranscriber can settle a sentence's full stop on its own.
    func testAnalyzerLonePunctuationJoinsWithoutASpace() {
        var transcript = DictationTranscript()
        transcript.finalize("write a short haiku about the ocean")
        transcript.finalize(" .")
        transcript.finalize(" finally send it.")
        XCTAssertEqual(transcript.text, "write a short haiku about the ocean. finally send it.")
    }

    func testChineseAndJapaneseJoinWithoutSpaces() {
        var transcript = DictationTranscript()
        transcript.finalize("你好。")
        transcript.finalize("今天天气很好。")
        XCTAssertEqual(transcript.text, "你好。今天天气很好。")
    }
}
