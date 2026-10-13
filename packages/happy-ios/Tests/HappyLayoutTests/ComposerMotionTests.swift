import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// Shaker.tsx and HomeDock.tsx's animation values.
final class ComposerShakeTests: XCTestCase {
    func testShakerKeyframes() {
        XCTAssertEqual(ComposerShake.shakerKeyframes(), [0, 3, -3, 3, -3, 0])
        XCTAssertEqual(ComposerShake.shakerKeyframes(amplitude: 6, count: 2), [0, 6, -6, 0])
        XCTAssertEqual(ComposerShake.shakerKeyframes(count: 0), [0, 0])
    }

    func testShakerKeyframesDecay() {
        let keyframes = ComposerShake.shakerKeyframes(decay: true)
        let expected: [CGFloat] = [0, 3, -1.5, 1, -0.75, 0]
        XCTAssertEqual(keyframes.count, expected.count)
        for (value, want) in zip(keyframes, expected) {
            XCTAssertEqual(value, want, accuracy: 0.0001)
        }
    }

    func testShakerRunsSixStepsFromRest() {
        let shake = ComposerShake.shaker
        XCTAssertEqual(shake.values, [0, 0, 3, -3, 3, -3, 0])
        XCTAssertEqual(shake.keyTimes.count, 7)
        for (index, time) in shake.keyTimes.enumerated() {
            XCTAssertEqual(time, Double(index) / 6, accuracy: 0.0001)
        }
        XCTAssertEqual(shake.duration, 0.3, accuracy: 0.0001)
    }

    func testRefusalIsFiftyMillisecondsAStep() {
        let shake = ComposerShake.refusal
        XCTAssertEqual(shake.values, [0, 3, -3, 3, -3, 0])
        let expected = [0, 0.2, 0.4, 0.6, 0.8, 1]
        XCTAssertEqual(shake.keyTimes.count, expected.count)
        for (time, want) in zip(shake.keyTimes, expected) {
            XCTAssertEqual(time, want, accuracy: 0.0001)
        }
        XCTAssertEqual(shake.duration, 0.25, accuracy: 0.0001)
    }

    func testEmptyOffsetsStayAtRest() {
        let shake = ComposerShake(offsets: [], step: 0.05)
        XCTAssertEqual(shake.values, [0])
        XCTAssertEqual(shake.keyTimes, [0])
        XCTAssertEqual(shake.duration, 0)
    }
}

final class AgentInputPrimaryFlashTests: XCTestCase {
    func testScaleAndWash() {
        XCTAssertEqual(AgentInputPrimaryFlash.scale(0), 1)
        XCTAssertEqual(AgentInputPrimaryFlash.scale(1), 1.1, accuracy: 0.0001)
        XCTAssertEqual(AgentInputPrimaryFlash.scale(0.5), 1.05, accuracy: 0.0001)
        XCTAssertEqual(AgentInputPrimaryFlash.overlayAlpha(0), 0)
        XCTAssertEqual(AgentInputPrimaryFlash.overlayAlpha(1), 0.55, accuracy: 0.0001)
        XCTAssertEqual(AgentInputPrimaryFlash.overlayAlpha(0.5), 0.275, accuracy: 0.0001)
    }

    func testNegativeAmountRests() {
        XCTAssertEqual(AgentInputPrimaryFlash.scale(-1), 1)
        XCTAssertEqual(AgentInputPrimaryFlash.overlayAlpha(-1), 0)
    }
}

final class AgentInputCardRevealTests: XCTestCase {
    private func assertReveal(
        _ value: (alpha: CGFloat, offsetY: CGFloat),
        _ alpha: CGFloat,
        _ offsetY: CGFloat,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertEqual(value.alpha, alpha, accuracy: 0.0001, file: file, line: line)
        XCTAssertEqual(value.offsetY, offsetY, accuracy: 0.0001, file: file, line: line)
    }

    func testInputRisesBetween22And60Percent() {
        assertReveal(AgentInputCardReveal.input(progress: 0), 0, 8)
        assertReveal(AgentInputCardReveal.input(progress: 0.22), 0, 8)
        assertReveal(AgentInputCardReveal.input(progress: 0.41), 0.5, 4)
        assertReveal(AgentInputCardReveal.input(progress: 0.6), 1, 0)
        assertReveal(AgentInputCardReveal.input(progress: 1), 1, 0)
    }

    func testActionsRiseBetween46And82Percent() {
        assertReveal(AgentInputCardReveal.actions(progress: 0.3), 0, 7)
        assertReveal(AgentInputCardReveal.actions(progress: 0.46), 0, 7)
        assertReveal(AgentInputCardReveal.actions(progress: 0.64), 0.5, 3.5)
        assertReveal(AgentInputCardReveal.actions(progress: 0.82), 1, 0)
        assertReveal(AgentInputCardReveal.actions(progress: 1.2), 1, 0)
    }
}

final class ComposerHomeTokenTests: XCTestCase {
    func testHomeDockPrimaryColors() {
        XCTAssertEqual(Palette.composerNewSessionPrimaryFill, ColorToken(light: RGBA(hex: "#000000")!, dark: RGBA(hex: "#F5F5F5")!))
        XCTAssertEqual(Palette.composerNewSessionPrimaryIcon, ColorToken(light: RGBA(hex: "#FFFFFF")!, dark: RGBA(hex: "#111111")!))
        XCTAssertEqual(Palette.composerPrimaryFlash, ColorToken(light: RGBA(hex: "#FFFFFF")!, dark: RGBA(hex: "#4A4A4E")!))
        XCTAssertTrue(Palette.composer.contains(Palette.composerNewSessionPrimaryFill))
        XCTAssertTrue(Palette.composer.contains(Palette.composerPrimaryFlash))
    }
}
