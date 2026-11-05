import Foundation
import XCTest
@testable import HappyCore
import HappyWire

private func json(_ text: String) -> JSONValue {
    try! JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
}

/// Artifact covers on the phone (feed-covers contract): the artifact
/// object's `cover`, `summary` and `background`, kept and followed through
/// events, and the Feed's post that a covered artifact's entry becomes.
/// The Highlights filter's wire: `filteredUnread` and health.
final class FeedCoverTests: XCTestCase {
    static let covered = #"""
    {"id":"r9","type":"html","title":"Revenue","status":"active","latestVersion":4,"fileCount":2,"createdAt":1,"updatedAt":2,
     "entry":{"path":"index.html","mimeType":"text/html","size":10},
     "cover":{"path":"cards/cover 1.png","mimeType":"image/png","width":1600,"height":900,"aspect":"wide"},
     "summary":"Revenue up 18% QoQ,\ndriven by enterprise seats.","background":"#0B1F33"}
    """#

    func testAnArtifactObjectCarriesItsCover() throws {
        let artifact = try XCTUnwrap(ArtifactSummary(json: json(Self.covered)))
        XCTAssertEqual(artifact.cover, ArtifactSummary.Cover(path: "cards/cover 1.png", mimeType: "image/png", width: 1600, height: 900, aspect: .wide))
        XCTAssertEqual(artifact.summary, "Revenue up 18% QoQ, driven by enterprise seats.", "one line")
        XCTAssertEqual(artifact.background, "#0b1f33")

        // Kept as the catalog keeps it, and read back the same.
        let kept = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(artifact))
        XCTAssertEqual(ArtifactSummary(json: kept), artifact)
    }

    /// An older daemon sends none; `null`, a cover with no size, no shape
    /// or one this phone doesn't know, or of a kind the Feed doesn't draw
    /// (SVG), is no cover at all.
    func testNoCoverIsNil() {
        func cover(_ value: String) -> ArtifactSummary.Cover? {
            ArtifactSummary(json: json(#"{"id":"a","type":"image","cover":\#(value)}"#))?.cover
        }
        XCTAssertNil(ArtifactSummary(json: json(#"{"id":"a","type":"image"}"#))?.cover)
        XCTAssertNil(cover("null"))
        XCTAssertNil(cover(#"{"path":"a.png","mimeType":"image/png","aspect":"wide"}"#))
        XCTAssertNil(cover(#"{"path":"a.png","mimeType":"image/png","width":0,"height":900,"aspect":"wide"}"#))
        XCTAssertNil(cover(#"{"path":"a.svg","mimeType":"image/svg+xml","width":1600,"height":900,"aspect":"wide"}"#))
        XCTAssertNil(cover(#"{"path":"","mimeType":"image/png","width":1600,"height":900,"aspect":"wide"}"#))
        XCTAssertNil(cover(#"{"path":"a.png","mimeType":"image/png","width":1600,"height":900}"#), "an older daemon's, with no shape")
        XCTAssertNil(cover(#"{"path":"a.png","mimeType":"image/png","width":900,"height":1600,"aspect":"tall"}"#), "a shape this phone doesn't know")
        let square = cover(#"{"path":"a.webp","mimeType":"image/WebP","width":1200,"height":1200,"aspect":"square"}"#)
        XCTAssertEqual(square?.mimeType, "image/webp")
        XCTAssertEqual(square?.aspect, .square)
        XCTAssertEqual(ArtifactSummary.Cover.Aspect.wide.ratio, 0.5625)
        XCTAssertEqual(ArtifactSummary.Cover.Aspect.square.ratio, 1)
        XCTAssertNil(ArtifactSummary(json: json(#"{"id":"a","background":"red","summary":"  "}"#))?.background)
        XCTAssertNil(ArtifactSummary(json: json(#"{"id":"a","summary":"  "}"#))?.summary)
    }

    /// `artifact.updated` carries them in its changes: a new one replaces
    /// the old, `null` clears it, and a change without them keeps them.
    func testUpdatesChangeAndClearTheCover() throws {
        let list = [try XCTUnwrap(ArtifactSummary(json: json(Self.covered)))]
        guard case .changed(let resized) = ArtifactCatalog.apply(json(#"""
        {"type":"artifact.updated","payload":{"artifactId":"r9","changes":{"latestVersion":5,
         "cover":{"path":"cards/cover 1.png","mimeType":"image/jpeg","width":1200,"height":1200,"aspect":"square"},"summary":"Now square."}}}
        """#), to: list) else { return XCTFail() }
        XCTAssertEqual(resized[0].cover?.width, 1200)
        XCTAssertEqual(resized[0].cover?.aspect, .square)
        XCTAssertEqual(resized[0].summary, "Now square.")
        XCTAssertEqual(resized[0].background, "#0b1f33", "kept")

        guard case .changed(let kept) = ArtifactCatalog.apply(json(#"{"type":"artifact.updated","payload":{"artifactId":"r9","changes":{"latestVersion":6}}}"#), to: resized) else { return XCTFail() }
        XCTAssertEqual(kept[0].cover, resized[0].cover, "a version that names none keeps the cover")

        guard case .changed(let cleared) = ArtifactCatalog.apply(json(#"{"type":"artifact.updated","payload":{"artifactId":"r9","changes":{"cover":null,"summary":null,"background":null}}}"#), to: kept) else { return XCTFail() }
        XCTAssertNil(cleared[0].cover)
        XCTAssertNil(cleared[0].summary)
        XCTAssertNil(cleared[0].background)
    }

    /// The post comes from the latest version, its path escaped segment by
    /// segment; only from a computer whose health says `artifactCovers`.
    func testACoveredArtifactsEntryIsAPost() throws {
        var artifacts = FeedFixture.artifacts()
        artifacts.append(try XCTUnwrap(ArtifactSummary(json: json(Self.covered))))
        let directory = FeedDirectory.make(desktop: try FeedFixture.desktop(), users: [:], artifacts: artifacts)
        let item = FeedFixture.item(1, "artifact", "r9", created: true)

        let row = try XCTUnwrap(FeedRows.row(item, unread: true, directory: directory, personSeed: "p", covers: true))
        XCTAssertEqual(row.post, FeedPost(
            image: "/v0/artifacts/r9/versions/4/files/cards/cover%201.png", aspect: .wide, width: 1600, height: 900,
            background: "#0b1f33", summary: "Revenue up 18% QoQ, driven by enterprise seats."
        ))
        XCTAssertEqual(row.face, .tile(.artifact, artifactType: "html"), "the row's own header stays")
        XCTAssertEqual(row.target, .artifact(Artifact(id: "r9", version: 4, type: "html", title: "Revenue", followsLatest: true)))

        XCTAssertNil(FeedRows.row(item, unread: true, directory: directory, personSeed: "p", covers: false)?.post, "without artifactCovers nothing changes")
        let artifact = try XCTUnwrap(ArtifactSummary(json: json(Self.covered)))
        XCTAssertEqual(artifact.coverPath, "/v0/artifacts/r9/versions/4/files/cards/cover%201.png", "the list's slot reads the same picture")
        var deleted = artifact
        deleted.deleted = true
        XCTAssertNil(deleted.coverPath, "a tombstone never shows its old cover")
        let plain = FeedFixture.item(2, "artifact", "r1")
        XCTAssertNil(FeedRows.row(plain, unread: true, directory: directory, personSeed: "p", covers: true)?.post, "no cover keeps the compact row")
    }

    func testAFilteredPageAndHealthDecode() throws {
        let page = try JSONDecoder().decode(FeedPage.self, from: Data(#"{"items":[],"unread":7,"filteredUnread":2,"hasMore":false}"#.utf8))
        XCTAssertEqual(page.unread, 7)
        XCTAssertEqual(page.filteredUnread, 2)
        XCTAssertNil(try JSONDecoder().decode(FeedPage.self, from: Data(#"{"items":[],"unread":7}"#.utf8)).filteredUnread)

        XCTAssertEqual(FeedCapabilities(health: json(#"{"capabilities":{"feed":true,"feedSubjectFilter":true,"artifactCovers":true}}"#)),
                       FeedCapabilities(feed: true, subjectFilter: true, covers: true))
        XCTAssertEqual(FeedCapabilities(health: json(#"{"capabilities":{"feed":true}}"#)), FeedCapabilities(feed: true))
    }

    func testHighlightsAreArtifactsAndTasks() {
        XCTAssertEqual(FeedFilter.highlights.subjects, ["artifact", "task"])
        XCTAssertNil(FeedFilter.all.subjects)
        let kinds = ["artifact", "task", "bot", "surface"].map { FeedFixture.item(1, $0, "x") }
        XCTAssertEqual(kinds.filter(FeedFilter.highlights.includes).map(\.subject.type), ["artifact", "task"])
        XCTAssertEqual(kinds.filter(FeedFilter.all.includes).count, 4)
    }
}
