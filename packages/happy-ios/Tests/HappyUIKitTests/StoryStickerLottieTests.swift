#if canImport(UIKit)
@testable import HappyCore
@testable import HappyUI
import UIKit
import XCTest

/// The Lottie player behind animated (`tgs`) stickers: it loops while asked
/// to play and holds still otherwise, and a file it can't read draws nothing.
@MainActor
final class StoryStickerLottieTests: XCTestCase {
    /// The generated test sticker (`scripts/generate-test-sticker-packs.py`).
    private let spin = Data(#"""
{"v":"5.7.4","fr":30,"ip":0,"op":60,"w":512,"h":512,"nm":"spin","ddd":0,"assets":[],"layers":[{"ddd":0,"ind":1,"ty":4,"nm":"spin","sr":1,"ao":0,"ip":0,"op":60,"st":0,"bm":0,"ks":{"o":{"a":0,"k":100},"r":{"a":1,"k":[{"t":0,"s":[0],"i":{"x":[0.5],"y":[1]},"o":{"x":[0.5],"y":[0]}},{"t":60,"s":[360]}]},"p":{"a":0,"k":[256,256,0]},"a":{"a":0,"k":[0,0,0]},"s":{"a":1,"k":[{"t":0,"s":[100,100,100],"i":{"x":[0.5,0.5,0.5],"y":[1,1,1]},"o":{"x":[0.5,0.5,0.5],"y":[0,0,0]}},{"t":30,"s":[70,70,100],"i":{"x":[0.5,0.5,0.5],"y":[1,1,1]},"o":{"x":[0.5,0.5,0.5],"y":[0,0,0]}},{"t":60,"s":[100,100,100]}]}},"shapes":[{"ty":"gr","nm":"dot","it":[{"ty":"el","nm":"e","d":1,"s":{"a":0,"k":[70,70]},"p":{"a":0,"k":[0,-90]}},{"ty":"fl","nm":"f","c":{"a":0,"k":[1,1,1,1]},"o":{"a":0,"k":100},"r":1},{"ty":"tr","p":{"a":0,"k":[0,0]},"a":{"a":0,"k":[0,0]},"s":{"a":0,"k":[100,100]},"r":{"a":0,"k":0},"o":{"a":0,"k":100}}]},{"ty":"gr","nm":"square","it":[{"ty":"rc","nm":"r","d":1,"s":{"a":0,"k":[300,300]},"p":{"a":0,"k":[0,0]},"r":{"a":0,"k":80}},{"ty":"fl","nm":"f","c":{"a":0,"k":[1,0.216,0.373,1]},"o":{"a":0,"k":100},"r":1},{"ty":"tr","p":{"a":0,"k":[0,0]},"a":{"a":0,"k":[0,0]},"s":{"a":0,"k":[100,100]},"r":{"a":0,"k":0},"o":{"a":0,"k":100}}]}]}]}
"""#.utf8)

    private func hosted(_ player: StoryStickerLottiePlayer) -> UIWindow {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 200, height: 200))
        player.view.frame = window.bounds
        window.addSubview(player.view)
        window.isHidden = false
        return window
    }

    func testItPlaysOnlyWhileAsked() {
        let player = StoryStickerLottiePlayer(data: spin)
        let window = hosted(player)
        XCTAssertFalse(player.isAnimating, "it waits to be asked")
        player.setPlaying(true)
        XCTAssertTrue(player.isAnimating)
        XCTAssertEqual(player.view.accessibilityValue, "playing")
        player.setPlaying(false)
        XCTAssertFalse(player.isAnimating)
        XCTAssertEqual(player.view.accessibilityValue, "paused")
        player.setPlaying(true)
        XCTAssertTrue(player.isAnimating, "it plays again from where it paused")
        window.isHidden = true
    }

    func testItLoopsAtTheFilesOwnRate() throws {
        let animation = try XCTUnwrap(StoryStickerLottiePlayer.decode(spin))
        XCTAssertEqual(animation.framerate, 30)
        XCTAssertEqual(animation.duration, 2, accuracy: 0.001)
        XCTAssertEqual(animation.size, CGSize(width: 512, height: 512))
    }

    /// As the app makes it: asked to play before its file is read, it plays
    /// once the file arrives; asked to stop before then, it never starts.
    func testItKeepsWhatItWasAskedWhileItsFileIsRead() async throws {
        let transport = Files(lottie: spin)
        let media = StoriesMedia(client: AgentClient(transport: transport, token: "test"))
        let sticker = Sticker(packId: "motion", id: "spin", emoji: ["🌀"], format: .tgs, width: 512, height: 512, size: spin.count, sha256: UUID().uuidString)
        let player = StoryStickerLottiePlayer(sticker: sticker, media: media)
        let window = hosted(player)
        player.setPlaying(true)
        XCTAssertFalse(player.isLoaded)
        XCTAssertEqual(player.view.accessibilityValue, "playing")
        for _ in 0..<100 where !player.isLoaded { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(player.isLoaded)
        XCTAssertTrue(player.isAnimating, "it plays once its file arrives")
        let asked = await transport.asked
        XCTAssertEqual(asked, ["/v0/stickers/packs/motion/stickers/spin/file?as=lottie"])

        let still = StoryStickerLottiePlayer(sticker: Sticker(packId: "motion", id: "spin", emoji: [], format: .tgs, width: 512, height: 512, size: spin.count, sha256: UUID().uuidString), media: media)
        let other = hosted(still)
        still.setPlaying(true)
        still.setPlaying(false)
        for _ in 0..<100 where !still.isLoaded { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(still.isLoaded)
        XCTAssertFalse(still.isAnimating, "a stop asked before its file arrived holds")
        window.isHidden = true
        other.isHidden = true
    }

    /// A computer that serves only the sticker's Lottie.
    private actor Files: AgentTransport {
        let lottie: Data
        private(set) var asked: [String] = []
        init(lottie: Data) { self.lottie = lottie }
        func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
            asked.append(path)
            return HTTP1Response(status: 200, headers: ["content-type": "application/json"], body: lottie)
        }
        func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
            HTTP1Stream(status: 503, body: AsyncThrowingStream { $0.finish() })
        }
        func reset() async {}
        func close() async {}
    }

    func testAFileItCantReadDrawsNothing() {
        XCTAssertNil(StoryStickerLottiePlayer.decode(Data("not lottie".utf8)))
        let player = StoryStickerLottiePlayer(data: Data([0x1f, 0x8b, 0x08]))
        let window = hosted(player)
        player.setPlaying(true)
        XCTAssertFalse(player.isAnimating)
        window.isHidden = true
    }
}
#endif
