#if canImport(UIKit)
@testable import HappyCore
@testable import HappyUI
import UIKit
import XCTest

/// A story's caption as Telegram's: folded to three lines with "… Show
/// more" where something can open it, opened in full over the darkened
/// frame, and folded again by a tap.
@MainActor
final class StoryCaptionTests: XCTestCase {
    private let long = String(repeating: "Six new routes on the overhang and a dyno I am weirdly proud of. ", count: 8)

    private func story(_ caption: String?) -> (Story, StoryFrame) {
        let frame = StoryFrame(id: "f", kind: .image, width: 720, height: 1280, thumbhash: nil, durationMs: nil, asset: .artifactFile(artifactId: "a", version: 1, path: "p.png"), available: false)
        let story = Story(id: "s", status: .posted, authorUserId: "u", createdBy: .user(userId: "u"), caption: caption, frames: [frame], artifactVersion: 1, createdAt: 0, updatedAt: 0, postedAt: 0, expiresAt: nil, seen: true, viewCount: nil, myReaction: nil, reactions: [], version: "1")
        return (story, frame)
    }

    private func canvas(_ caption: String?, expands: ((Bool) -> Void)?) -> StoryCanvasView {
        let canvas = StoryCanvasView(frame: CGRect(x: 0, y: 0, width: 390, height: 693))
        canvas.onCaptionExpanded = expands
        let (story, frame) = story(caption)
        canvas.show(story, frame: frame, media: nil)
        canvas.layoutIfNeeded()
        return canvas
    }

    private func find<T: UIView>(_ id: String, in view: UIView) -> T? {
        if view.accessibilityIdentifier == id, let match = view as? T { return match }
        for sub in view.subviews { if let match: T = find(id, in: sub) { return match } }
        return nil
    }

    func testALongCaptionFoldsToThreeLinesEndingInShowMore() throws {
        let font = UIFont.systemFont(ofSize: 16)
        let folded = try XCTUnwrap(StoryCanvasView.folded(long, font: font, width: 358, lines: 3))
        XCTAssertTrue(folded.string.hasSuffix("\u{2026} Show more"))
        let height = folded.boundingRect(with: CGSize(width: 358, height: CGFloat.greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil).height
        XCTAssertLessThanOrEqual(height, ceil(font.lineHeight * 3) + 1)
        // As much of it as fits: one more word would not.
        XCTAssertGreaterThan(folded.string.count, 120)
        XCTAssertNil(StoryCanvasView.folded("Late night", font: font, width: 358, lines: 3))
    }

    func testATapOpensItAndAnotherFoldsIt() throws {
        var told: [Bool] = []
        let canvas = canvas(long, expands: { told.append($0) })
        let label: UILabel = try XCTUnwrap(find("story-caption", in: canvas))
        let more: UIControl = try XCTUnwrap(find("story-caption-more", in: canvas))
        XCTAssertFalse(more.isHidden)
        XCTAssertTrue(label.attributedText?.string.hasSuffix("Show more") == true)
        more.sendActions(for: .touchUpInside)
        XCTAssertTrue(canvas.captionExpanded)
        XCTAssertEqual(told, [true])
        let open: UILabel = try XCTUnwrap(find("story-caption-open", in: canvas))
        XCTAssertEqual(open.text, long)
        canvas.setCaptionExpanded(false, animated: false)
        XCTAssertFalse(canvas.captionExpanded)
        XCTAssertEqual(told, [true, false])
    }

    func testWithNothingToOpenItTheCaptionShowsWhole() throws {
        let canvas = canvas(long, expands: nil)
        let more: UIControl = try XCTUnwrap(find("story-caption-more", in: canvas))
        XCTAssertTrue(more.isHidden)
        canvas.setCaptionExpanded(true)
        XCTAssertFalse(canvas.captionExpanded)
        // A short caption has nothing to open either.
        let short = self.canvas("Late night", expands: { _ in XCTFail("opened") })
        let shortMore: UIControl = try XCTUnwrap(find("story-caption-more", in: short))
        XCTAssertTrue(shortMore.isHidden)
    }

    func testAnotherStoryFoldsAnOpenCaption() {
        var told: [Bool] = []
        let canvas = canvas(long, expands: { told.append($0) })
        canvas.setCaptionExpanded(true, animated: false)
        var (next, frame) = story("Another")
        next.id = "s2"
        frame.id = "f2"
        canvas.show(next, frame: frame, media: nil)
        XCTAssertFalse(canvas.captionExpanded)
        XCTAssertEqual(told, [true, false])
    }
    func testWidenedSoItFitsAnOpenCaptionFolds() {
        var told: [Bool] = []
        let caption = String(repeating: "Six new routes on the overhang. ", count: 3)
        let canvas = StoryCanvasView(frame: CGRect(x: 0, y: 0, width: 200, height: 400))
        canvas.onCaptionExpanded = { told.append($0) }
        let (story, frame) = story(caption)
        canvas.show(story, frame: frame, media: nil)
        canvas.layoutIfNeeded()
        canvas.setCaptionExpanded(true, animated: false)
        XCTAssertTrue(canvas.captionExpanded)
        canvas.frame = CGRect(x: 0, y: 0, width: 1000, height: 1800)
        canvas.layoutIfNeeded()
        XCTAssertFalse(canvas.captionExpanded)
        XCTAssertEqual(told, [true, false])
    }
}
#endif
