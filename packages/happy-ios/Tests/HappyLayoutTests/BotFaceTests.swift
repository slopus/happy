import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// The expected values are @dicebear/core 10.7.0's own, with
/// @dicebear/styles 10.6.0's Adventurer Neutral, run under Node.
final class BotFaceTests: XCTestCase {
    func testTheGeneratorsKeyedRandomness() {
        XCTAssertEqual(BotFacePrng.fnv1a(""), 2_166_136_261)
        XCTAssertEqual(BotFacePrng.fnv1a("abc"), 440_920_331)
        XCTAssertEqual(BotFacePrng.fnv1a("seed0000:eyesVariant"), 1_403_666_945)
        XCTAssertEqual(BotFacePrng.fnv1a("😀"), 3_409_036_472, "UTF-16 code units, as charCodeAt")

        var mulberry = BotFacePrng.Mulberry32(state: 12345)
        XCTAssertEqual([mulberry.next(), mulberry.next(), mulberry.next()], [4_207_900_869, 1_317_490_944, 2_079_646_450])

        let prng = BotFacePrng(seed: "seed0000")
        XCTAssertEqual(prng.value("eyesVariant"), 0.23933207197114825)
        XCTAssertEqual(prng.shuffle("backgroundColor", ["#f2d3b1", "#ecad80", "#9e5622", "#763900"]), ["#9e5622", "#ecad80", "#f2d3b1", "#763900"])
        XCTAssertEqual(prng.pick("k", ["b", "a", "c"]), "a")
        XCTAssertEqual(prng.weightedPick("w", ["a": 1, "b": 2, "c": 0]), "b")
        XCTAssertFalse(prng.bool("glassesProbability", likelihood: 10))
    }

    func testSeedsPickWhatDiceBearPicks() {
        let expected = [
            "seed0000 9e5622 eyes:variant07 eyebrows:variant09 mouth:variant19",
            "seed2222 763900 eyes:variant10 eyebrows:variant15 mouth:variant23",
            "g0000029 9e5622 eyes:variant26 eyebrows:variant13 mouth:variant11 glasses:variant01",
            "g0000044 763900 eyes:variant11 eyebrows:variant13 mouth:variant06 glasses:variant03",
            "g0000045 ecad80 eyes:variant23 eyebrows:variant10 mouth:variant25 glasses:variant04",
            "héllo f2d3b1 eyes:variant10 eyebrows:variant02 mouth:variant12",
            " ecad80 eyes:variant26 eyebrows:variant01 mouth:variant07",
        "000078q1 f2d3b1 eyes:variant04 eyebrows:variant08 mouth:variant11",
        "00l514q6 763900 eyes:variant03 eyebrows:variant11 mouth:variant21",
        "007fter2 9e5622 eyes:variant12 eyebrows:variant04 mouth:variant12",
        "008khldd 763900 eyes:variant12 eyebrows:variant02 mouth:variant04",
        "00rjrh5p 9e5622 eyes:variant08 eyebrows:variant11 mouth:variant24",
        "00bn5aly f2d3b1 eyes:variant10 eyebrows:variant03 mouth:variant29",
        "00lhb60q 9e5622 eyes:variant13 eyebrows:variant09 mouth:variant21",
        "00rx0qcx ecad80 eyes:variant23 eyebrows:variant01 mouth:variant01",
        "00tufc5y 9e5622 eyes:variant18 eyebrows:variant11 mouth:variant30",
        "0079kqri 763900 eyes:variant21 eyebrows:variant07 mouth:variant13",
        "00m9fy7p 9e5622 eyes:variant13 eyebrows:variant07 mouth:variant30",
        "00wrrf2k 763900 eyes:variant10 eyebrows:variant06 mouth:variant08",
        "002oo2wh 9e5622 eyes:variant19 eyebrows:variant08 mouth:variant16 glasses:variant02",
        "00nor5ls ecad80 eyes:variant05 eyebrows:variant15 mouth:variant14",
        "0053dvab 763900 eyes:variant04 eyebrows:variant09 mouth:variant30",
        "00ko3r4o f2d3b1 eyes:variant22 eyebrows:variant04 mouth:variant20",
        "004ufxut 9e5622 eyes:variant06 eyebrows:variant11 mouth:variant14",
        "00yakack 9e5622 eyes:variant05 eyebrows:variant02 mouth:variant29",
        "002yqini f2d3b1 eyes:variant03 eyebrows:variant05 mouth:variant19",
        "00r7qc33 ecad80 eyes:variant10 eyebrows:variant13 mouth:variant21",
        "002tx6im ecad80 eyes:variant07 eyebrows:variant09 mouth:variant18",
        "00yvzwdl f2d3b1 eyes:variant05 eyebrows:variant04 mouth:variant07 glasses:variant04",
        "00aj2kde ecad80 eyes:variant02 eyebrows:variant08 mouth:variant01",
        "00ka1ld1 f2d3b1 eyes:variant24 eyebrows:variant07 mouth:variant08",
        "00b1aqz9 ecad80 eyes:variant03 eyebrows:variant13 mouth:variant30",
        "00pya53m ecad80 eyes:variant12 eyebrows:variant14 mouth:variant15",
        "005fluon 9e5622 eyes:variant08 eyebrows:variant12 mouth:variant09",
        "0007k376 9e5622 eyes:variant15 eyebrows:variant01 mouth:variant12",
        "00cctp8r f2d3b1 eyes:variant03 eyebrows:variant08 mouth:variant26",
        "0022e1tr 763900 eyes:variant08 eyebrows:variant02 mouth:variant20",
        "00jnxyg9 763900 eyes:variant02 eyebrows:variant11 mouth:variant17",
        "00w1wuku ecad80 eyes:variant25 eyebrows:variant11 mouth:variant08",
        "005njj27 f2d3b1 eyes:variant07 eyebrows:variant10 mouth:variant23",
        "00lgkg8l f2d3b1 eyes:variant18 eyebrows:variant13 mouth:variant10",
        "00r9xwne 763900 eyes:variant01 eyebrows:variant06 mouth:variant01",
        "00irpfja f2d3b1 eyes:variant18 eyebrows:variant15 mouth:variant10",
        "00t9img0 9e5622 eyes:variant15 eyebrows:variant12 mouth:variant18 glasses:variant01",
        "00sriji6 ecad80 eyes:variant04 eyebrows:variant04 mouth:variant09",
        "0057r9sp 763900 eyes:variant15 eyebrows:variant04 mouth:variant03",
        "00n9z78n 9e5622 eyes:variant16 eyebrows:variant14 mouth:variant19",
        ]
        for line in expected {
            let fields = line.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
            let face = BotFace(seed: fields[0])
            let described = [face.background.dropFirst().description] + face.parts.map { "\($0.component):\($0.variant)" }
            XCTAssertEqual(described, Array(fields.dropFirst()), "seed \(fields[0].debugDescription)")
        }
    }

    func testTheGeneratedStyle() {
        let style = BotFaceStyle.adventurerNeutral
        XCTAssertEqual(style.canvas, CGSize(width: 400, height: 400))
        XCTAssertEqual(style.backgrounds, ["#f2d3b1", "#ecad80", "#9e5622", "#763900"])
        XCTAssertEqual(style.components.map(\.name), ["eyes", "eyebrows", "mouth", "glasses"])
        XCTAssertEqual(style.components.map(\.variants.count), [26, 15, 30, 5])
        XCTAssertEqual(style.components.map(\.probability), [100, 100, 100, 10])
        XCTAssertEqual(style.components.flatMap(\.variants).map(\.shapes.count).reduce(0, +), 225)
        XCTAssertEqual(BotFaceStyle.adventurerNeutralCredit.artist, "Lisa Wischofsky")

        var checksum: UInt64 = 0xCBF2_9CE4_8422_2325
        for byte in BotFaceStyle.adventurerNeutralTable.utf8 {
            checksum ^= UInt64(byte)
            checksum = checksum &* 0x0100_0000_01B3
        }
        XCTAssertEqual(checksum, BotFaceStyle.adventurerNeutralChecksum, "rerun scripts/generate-bot-faces.py")
    }

    func testAFacesShapesAreDiceBearsFills() {
        let face = BotFace(seed: "g0000029")
        let black = RGBA(hex: "#000000")!
        let white = RGBA(hex: "#ffffff")!
        XCTAssertEqual(face.shapes().map(\.fill), [
            black, white, black, white, black,
            black,
            black, white,
            black, black, white, white,
        ])
        // Every outline sits inside the canvas, the component's place applied.
        let canvas = CGRect(x: 0, y: 0, width: 400, height: 400)
        for shape in face.shapes() {
            XCTAssertTrue(canvas.contains(shape.path.controlBounds), "\(shape.path.controlBounds)")
        }
    }
}
