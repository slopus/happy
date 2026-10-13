import Foundation
@testable import HappyIcons
import HappyLayout
import XCTest

final class IconCatalogTests: XCTestCase {
    func testIconsAreNamedLikeTheRNCode() {
        XCTAssertEqual(Icon.ionicons("chevron-forward"), Icon(.ionicons, "chevron-forward"))
        XCTAssertEqual(IconFamily.materialCommunityIcons.rawValue, "MaterialCommunityIcons")
    }

    func testTablesComeFromTheLockedPackageAndMatchTheirChecksum() {
        XCTAssertEqual(IconCatalog.sourceVersion, "15.0.3")
        // The generator writes the checksum; a hand edit to a table, or a
        // generator that stopped being deterministic, breaks it.
        XCTAssertTrue(IconCatalog.checksumMatches)
    }

    func testEveryGeneratedIconDecodes() {
        let icons = IconCatalog.allIcons
        XCTAssertGreaterThan(icons.count, 200)
        XCTAssertEqual(Set(icons).count, icons.count, "an icon is listed twice")
        for icon in icons {
            guard let glyph = IconCatalog.glyph(for: icon) else {
                XCTFail("\(icon.family.rawValue) \(icon.name) is listed but doesn't decode")
                continue
            }
            XCTAssertFalse(glyph.path.elements.isEmpty, "\(icon.name) has no outline")
            XCTAssertGreaterThan(glyph.advance, 0, icon.name)
            XCTAssertGreaterThan(glyph.unitsPerEm, 0, icon.name)
            XCTAssertGreaterThan(glyph.ascender, 0, icon.name)
            XCTAssertLessThanOrEqual(glyph.descender, 0, icon.name)
        }
    }

    /// Every icon HappyUI names in code is generated. A name missing from
    /// the tables would draw as an empty square.
    func testEveryIconTheAppNamesIsGenerated() throws {
        let sources = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/HappyUI")
        let families: [String: IconFamily] = [
            "ionicons": .ionicons, "octicons": .octicons, "materialCommunityIcons": .materialCommunityIcons,
            "materialIcons": .materialIcons, "feather": .feather, "fontAwesome": .fontAwesome,
            "fontAwesome5": .fontAwesome5,
        ]
        let pattern = try NSRegularExpression(pattern: #"\.(\w+)\("([a-z0-9-]+)"\)"#)
        var named: Set<Icon> = []
        let files = FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil)
        while let file = files?.nextObject() as? URL {
            guard file.pathExtension == "swift" else { continue }
            let text = try String(contentsOf: file, encoding: .utf8)
            for match in pattern.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
                guard let familyRange = Range(match.range(at: 1), in: text),
                      let nameRange = Range(match.range(at: 2), in: text),
                      let family = families[String(text[familyRange])] else { continue }
                named.insert(Icon(family, String(text[nameRange])))
            }
        }
        XCTAssertFalse(named.isEmpty, "found no icon names in \(sources.path)")
        for icon in named.sorted(by: { $0.name < $1.name }) {
            XCTAssertNotNil(IconCatalog.glyph(for: icon), "\(icon.family.rawValue) \(icon.name) is named in HappyUI but not generated")
        }
    }

    func testAnIconThatWasNotGeneratedIsNil() {
        XCTAssertNil(IconCatalog.glyph(for: .ionicons("not-an-icon")))
        XCTAssertNil(IconCatalog.glyph(for: .fontAwesome("chevron-forward")))
    }

    // Expected values below were read from the fonts by an independent path:
    // the Python TrueType reader in scripts/generate-icons.py (point bounds,
    // and its own contour-to-path walk for the element counts).

    func testIoniconsChevronForward() throws {
        let glyph = try XCTUnwrap(IconCatalog.glyph(for: .ionicons("chevron-forward")))
        XCTAssertEqual(glyph.metrics, IconMetrics(unitsPerEm: 512, advance: 512, ascender: 454, descender: -71))
        XCTAssertEqual(counts(glyph.path), Counts(moves: 1, lines: 1, quads: 17, closes: 1))
        // Font bbox 159,23 – 352,361 (y up); here y runs down from the
        // ascender line, 454 - y.
        XCTAssertEqual(glyph.path.controlBounds, CGRect(x: 159, y: 454 - 361, width: 352 - 159, height: 361 - 23))
    }

    func testIoniconsQRCodeOutlineHasEveryContour() throws {
        let glyph = try XCTUnwrap(IconCatalog.glyph(for: .ionicons("qr-code-outline")))
        XCTAssertEqual(counts(glyph.path), Counts(moves: 14, lines: 96, quads: 68, closes: 14))
        XCTAssertEqual(glyph.path.controlBounds, CGRect(x: 31, y: 454 - 415, width: 481 - 31, height: 415 + 33))
    }

    func testIoniconsCheckmarkCircleIsAllCurves() throws {
        let glyph = try XCTUnwrap(IconCatalog.glyph(for: .ionicons("checkmark-circle")))
        XCTAssertEqual(counts(glyph.path), Counts(moves: 2, lines: 0, quads: 33, closes: 2))
        XCTAssertEqual(glyph.path.controlBounds, CGRect(x: 40, y: 454 - 404, width: 464 - 40, height: 404 + 16))
    }

    /// Three of its four contours start off the curve, so this exercises
    /// the implied on-curve start point.
    func testOcticonsGitBranch() throws {
        let glyph = try XCTUnwrap(IconCatalog.glyph(for: .octicons("git-branch")))
        XCTAssertEqual(glyph.metrics, IconMetrics(unitsPerEm: 512, advance: 512, ascender: 450, descender: -68))
        XCTAssertEqual(counts(glyph.path), Counts(moves: 4, lines: 8, quads: 56, closes: 4))
        XCTAssertEqual(glyph.path.controlBounds, CGRect(x: 64, y: 450 - 416, width: 448 - 64, height: 416 + 32))
    }

    func testMaterialCommunityIconsTree() throws {
        let glyph = try XCTUnwrap(IconCatalog.glyph(for: .materialCommunityIcons("tree")))
        XCTAssertEqual(glyph.metrics, IconMetrics(unitsPerEm: 512, advance: 512, ascender: 448, descender: -64))
        XCTAssertEqual(counts(glyph.path), Counts(moves: 1, lines: 3, quads: 18, closes: 1))
        XCTAssertEqual(glyph.path.controlBounds, CGRect(x: 107, y: 448 - 384, width: 427 - 107, height: 384))
    }

    func testMaterialIconsLink() throws {
        let glyph = try XCTUnwrap(IconCatalog.glyph(for: .materialIcons("link")))
        XCTAssertEqual(glyph.metrics, IconMetrics(unitsPerEm: 512, advance: 512, ascender: 512, descender: 0))
        XCTAssertEqual(counts(glyph.path), Counts(moves: 3, lines: 14, quads: 16, closes: 3))
        XCTAssertEqual(glyph.path.controlBounds, CGRect(x: 43, y: 512 - 363, width: 469 - 43, height: 363 - 149))
    }

    func testFeatherGift() throws {
        let glyph = try XCTUnwrap(IconCatalog.glyph(for: .feather("gift")))
        XCTAssertEqual(counts(glyph.path), Counts(moves: 8, lines: 15, quads: 58, closes: 8))
        XCTAssertEqual(glyph.path.controlBounds, CGRect(x: 21, y: 457 - 427, width: 491 - 21, height: 427 + 43))
    }

    /// TrueType's rules, on a contour of four off-curve points: it starts
    /// halfway between the last and the first, and each pair of off-curve
    /// points implies the on-curve point between them.
    func testDecodingImpliesOnCurvePoints() throws {
        // 1 contour of 4 points, all off the curve, at (0,0) (10,0) (10,10)
        // (0,10): zigzag deltas 0,0  20,0  0,20  19,0.
        let bytes: [UInt8] = [1, 4, 0b0000, 0, 0, 20, 0, 0, 20, 19, 0]
        let path = try XCTUnwrap(GlyphOutline.decode(Substring(Data(bytes).base64EncodedString())))
        XCTAssertEqual(path.elements, [
            .move(CGPoint(x: 0, y: 5)),
            .quadCurve(to: CGPoint(x: 5, y: 0), control: CGPoint(x: 0, y: 0)),
            .quadCurve(to: CGPoint(x: 10, y: 5), control: CGPoint(x: 10, y: 0)),
            .quadCurve(to: CGPoint(x: 5, y: 10), control: CGPoint(x: 10, y: 10)),
            .quadCurve(to: CGPoint(x: 0, y: 5), control: CGPoint(x: 0, y: 10)),
            .close,
        ])
    }

    func testDecodingLinesAndALastPointStart() throws {
        // A triangle whose first point is off the curve and last is on:
        // (5,0) off, (10,10) on, (0,10) on. Starts at the last point.
        let bytes: [UInt8] = [1, 3, 0b110, 10, 0, 10, 20, 19, 0]
        let path = try XCTUnwrap(GlyphOutline.decode(Substring(Data(bytes).base64EncodedString())))
        XCTAssertEqual(path.elements, [
            .move(CGPoint(x: 0, y: 10)),
            .quadCurve(to: CGPoint(x: 10, y: 10), control: CGPoint(x: 5, y: 0)),
            .close,
        ])
    }

    func testTruncatedDataDoesNotDecode() {
        let bytes: [UInt8] = [1, 4, 0, 0, 0, 20]
        XCTAssertNil(GlyphOutline.decode(Substring(Data(bytes).base64EncodedString())))
        XCTAssertNil(GlyphOutline.decode("not base64!"))
    }

    private struct Counts: Equatable {
        var moves = 0, lines = 0, quads = 0, closes = 0
    }

    private func counts(_ path: VectorPath) -> Counts {
        var result = Counts()
        for element in path.elements {
            switch element {
            case .move: result.moves += 1
            case .line: result.lines += 1
            case .quadCurve: result.quads += 1
            case .curve: XCTFail("TrueType outlines have no cubic curves")
            case .close: result.closes += 1
            }
        }
        return result
    }
}
