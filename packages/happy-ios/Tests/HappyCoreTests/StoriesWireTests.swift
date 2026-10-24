import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// The Swift Stories and Stickers models against samples checked by
/// @slopus/happy-agent-client's own TypeBox schemas
/// (`scripts/generate-stories-fixtures.ts`): each decodes and encodes back
/// to the same JSON, and the client's constants and grid agree.
final class StoriesWireTests: XCTestCase {
    private func fixture() throws -> JSONValue {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "stories-wire", withExtension: "json", subdirectory: "Fixtures"))
        return try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
    }

    private func roundTrip<T: Codable>(_ type: T.Type, _ samples: JSONValue?, file: StaticString = #filePath, line: UInt = #line) throws {
        let samples = try XCTUnwrap(samples?.arrayValue, file: file, line: line)
        XCTAssertFalse(samples.isEmpty, file: file, line: line)
        for sample in samples {
            let decoded = try JSONDecoder().decode(T.self, from: JSONEncoder().encode(sample))
            let encoded = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(decoded))
            XCTAssertEqual(encoded, sample, file: file, line: line)
        }
    }

    func testEverySampleRoundTrips() throws {
        let samples = try fixture()["samples"]
        try roundTrip(Story.self, samples?["story"])
        try roundTrip(StoryFeed.self, samples?["feed"])
        try roundTrip(StoriesPage.self, samples?["page"])
        try roundTrip(StoryMediaPage.self, samples?["media"])
        try roundTrip(StoryViewersPage.self, samples?["viewers"])
        try roundTrip(StickerPackContents.self, samples?["pack"])
        try roundTrip(StickerRecents.self, samples?["recents"])
    }

    func testOverlaysDecodeToTheirKinds() throws {
        let story = try JSONDecoder().decode(Story.self, from: JSONEncoder().encode(try XCTUnwrap(fixture()["samples"]?["story"]?.arrayValue?.first)))
        let kinds = story.frames[0].overlays.map { overlay -> String in
            switch overlay {
            case .text: "text"
            case .link: "link"
            case .sticker: "sticker"
            case .emoji: "emoji"
            case .reaction: "reaction"
            case .unknown: "unknown"
            }
        }
        XCTAssertEqual(kinds, ["text"] + Array(repeating: "text", count: 8) + ["link", "link", "sticker", "emoji", "reaction", "reaction"])
        guard case .reaction(_, let emoji, let dark, let flipped, _) = story.frames[0].overlays.last else { return XCTFail() }
        XCTAssertEqual(emoji, "🔥"); XCTAssertEqual(dark, true); XCTAssertEqual(flipped, true)
    }

    /// A newer daemon's overlay is kept as sent, never drawn, and sent back.
    func testAnUnknownOverlayIsKept() throws {
        let raw = #"{"id":"o9","type":"poll","question":"Ship it?","transform":{"x":0.5,"y":0.5,"scale":1,"rotation":0}}"#
        let overlay = try JSONDecoder().decode(StoryOverlay.self, from: Data(raw.utf8))
        guard case .unknown = overlay else { return XCTFail("decoded as a known kind") }
        XCTAssertEqual(overlay.id, "o9")
        XCTAssertNil(overlay.transform)
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(overlay)), try JSONDecoder().decode(JSONValue.self, from: Data(raw.utf8)))
    }

    /// Frame inputs encode exactly as the TypeScript `storyFrameInputSchema` accepts them.
    func testFrameInputsEncodeAsTheClientDoes() throws {
        let expected = try XCTUnwrap(fixture()["samples"]?["frameInputs"]?.arrayValue)
        let text = try JSONDecoder().decode(StoryOverlay.self, from: JSONEncoder().encode(try XCTUnwrap(expected[2]["overlays"]?.arrayValue?.first)))
        let inputs = [
            StoryFrameInput(id: "f1", media: .upload(uploadId: "u8p2l4o6a1d3e5f7g9h0j2k4", name: "IMG_0042.jpg"), overlays: []),
            StoryFrameInput(id: nil, media: .asset(.chatMedia(agentId: "a", toolCallId: "t", index: 1)), overlays: []),
            StoryFrameInput(id: "f2", media: .keep, placement: StoryTransform(x: 0.5, y: 0.5, scale: 1.2, rotation: 0), background: ["#000000", "#FFFFFF"], overlays: [text]),
        ]
        for (input, json) in zip(inputs, expected) {
            XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(input)), json)
        }
    }

    func testConstantsMatchTheClient() throws {
        let constants = try XCTUnwrap(fixture()["constants"])
        XCTAssertEqual(constants["canvas"]?["width"]?.numberValue, StoryCanvas.width)
        XCTAssertEqual(constants["canvas"]?["height"]?.numberValue, StoryCanvas.height)
        XCTAssertEqual(constants["maxFrames"]?.numberValue, Double(StoryCanvas.maxFrames))
        XCTAssertEqual(constants["maxOverlays"]?.numberValue, Double(StoryCanvas.maxOverlays))
        XCTAssertEqual(constants["maxCaption"]?.numberValue, Double(StoryCanvas.maxCaption))
        XCTAssertEqual(constants["lifetimeMs"]?.numberValue, Double(StoryCanvas.lifetimeMs))
        XCTAssertEqual(constants["imageDurationMs"]?.numberValue, Double(StoryCanvas.imageDurationMs))
        XCTAssertEqual(constants["maxVideoDurationMs"]?.numberValue, Double(StoryCanvas.maxVideoDurationMs))
        XCTAssertEqual(constants["settingKey"]?.stringValue, DirectAgentClient.storiesSettingKey)
        XCTAssertEqual(constants["fonts"]?.arrayValue?.compactMap(\.stringValue), StoryTextFont.allCases.map(\.rawValue))
        XCTAssertEqual(constants["fills"]?.arrayValue?.compactMap(\.stringValue), StoryTextFill.allCases.map(\.rawValue))
        XCTAssertEqual(constants["linkStyles"]?.arrayValue?.compactMap(\.stringValue), StoryLinkStyle.allCases.map(\.rawValue))
        let grid = try XCTUnwrap(constants["grid"]?.arrayValue)
        XCTAssertGreaterThan(grid.count, 20)
        for cell in grid {
            let kind = try XCTUnwrap(cell["kind"]?.stringValue.flatMap(StickerPackKind.init(rawValue:)))
            let width = try XCTUnwrap(cell["width"]?.numberValue), spacing = try XCTUnwrap(cell["spacing"]?.numberValue)
            XCTAssertEqual(Double(StickerGrid.columns(kind, width: width, spacing: spacing)), cell["columns"]?.numberValue, "\(kind) \(width) \(spacing)")
        }
    }

    func testAFrameShowsForItsDuration() {
        let asset = StoryAsset.chatMedia(agentId: "a", toolCallId: "t", index: 0)
        XCTAssertEqual(StoryFrame(id: "f", kind: .image, width: 1, height: 1, thumbhash: nil, durationMs: 9000, asset: asset, available: true).showMs, 5000)
        XCTAssertEqual(StoryFrame(id: "f", kind: .video, width: nil, height: nil, thumbhash: nil, durationMs: 9000, asset: asset, available: true).showMs, 9000)
        XCTAssertEqual(StoryFrame(id: "f", kind: .video, width: nil, height: nil, thumbhash: nil, durationMs: 90000, asset: asset, available: true).showMs, 60000)
        XCTAssertEqual(StoryFrame(id: "f", kind: .video, width: nil, height: nil, thumbhash: nil, durationMs: nil, asset: asset, available: true).showMs, 5000)
    }

    func testTransformsClampToTheKeptRanges() {
        let wild = StoryTransform(x: -3, y: 9, scale: 0, rotation: 7).clamped
        XCTAssertEqual(wild, StoryTransform(x: -0.5, y: 1.5, scale: 0.05, rotation: .pi))
    }
}
