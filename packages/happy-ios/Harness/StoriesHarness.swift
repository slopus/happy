#if canImport(UIKit) && (DEBUG || HAPPY_FIXTURES)
@testable import HappyCore
import HappyLayout
@testable import HappyUI
import AVFoundation
import HappyWire
import UIKit

/// Stories over a computer of the harness's own (`-screen stories`): three
/// authors, one of them the person, with pictures drawn here, so the UI
/// tests can drive the viewer with a finger where a standalone daemon has
/// nobody else's stories to show: the cube between authors, reactions, the
/// heart's other emoji.
///
/// `stories-probe`'s accessibility value reports the viewer:
/// `viewer=1 author=1 position=0 paused=0 chrome=1 reaction=🔥 haptics=open,react`,
/// or the editor: `editor=1 frames=1 overlays=sticker,text trail=… saved=draft:2`.
/// `-storiesCompose` opens the editor on a picture of the harness's own, as
/// a conversation's draft would; its "+" opens the real library sheet over
/// the simulator's photos.
/// The stories sit in a home header over a list of the harness's own, as
/// Stem Cells home has them; `header=open` or `header=closed` in the probe,
/// and `stories=N` how many the row has. `harness-new-story` posts another
/// of Ana's, unseen, as a `story.posted` event brings it.
@MainActor
final class StoriesHarness {
    private let window: UIWindow
    private let transport = StoriesHarnessTransport(videos: ProcessInfo.processInfo.arguments.contains("-storiesVideo"), epoch: StoriesHarness.epoch,
                                                    newer: ProcessInfo.processInfo.arguments.contains("-storiesNewer"))

    /// The stories' clock: `-storiesEpoch MS` dates them from the same
    /// moment across launches, else now.
    private static var epoch: Int64 {
        let arguments = ProcessInfo.processInfo.arguments
        if let index = arguments.firstIndex(of: "-storiesEpoch"), arguments.indices.contains(index + 1), let value = Int64(arguments[index + 1]) { return value }
        return Int64(Date().timeIntervalSince1970 * 1000)
    }
    private let session: StoriesSession
    private let host: StoriesHarnessHome
    private let probe = UILabel()
    private let recorder = StoriesHarnessHaptics()
    private var watch: StemCellsWatch?
    private var snapshot = StoriesSnapshot()
    private var timer: Timer?

    init(window: UIWindow) {
        self.window = window
        let arguments = ProcessInfo.processInfo.arguments
        // The one-time tooltip only for the test that looks at it.
        if arguments.contains("-storiesTooltip") {
            UserDefaults.standard.removeObject(forKey: StoriesHomeController.tooltipShownKey)
        } else {
            UserDefaults.standard.set(true, forKey: StoriesHomeController.tooltipShownKey)
        }
        // The row starts closed, as put away long ago, but for the tests of
        // how it starts: `-storiesFresh` never put away, `-storiesKept` as
        // the last run left it.
        if arguments.contains("-storiesFresh") {
            UserDefaults.standard.removeObject(forKey: StoriesHomeController.putAwayKey)
        } else if !arguments.contains("-storiesKept") {
            UserDefaults.standard.set(["stories-harness": NSNumber(value: Int64.max)], forKey: StoriesHomeController.putAwayKey)
        }
        // Every animation N times slower, to film one.
        if let index = arguments.firstIndex(of: "-storiesSlowMotion"), arguments.indices.contains(index + 1), let slower = Float(arguments[index + 1]), slower > 0 {
            window.layer.speed = 1 / slower
        }
        if let index = arguments.firstIndex(of: "-storiesShowScale"), arguments.indices.contains(index + 1), let scale = Double(arguments[index + 1]) {
            StoryViewerViewController.showScale = scale
        }
        let client = DirectAgentClient(transport: transport, token: "harness")
        let (events, arrive) = AsyncStream.makeStream(of: StemCellsStore.ConversationEvent.self)
        session = StoriesSession(accountID: "stories-harness", client: client, images: StemCellsImages(client: client), offline: nil) {
            events
        }
        host = StoriesHarnessHome(session: session)
        let session = session
        let transport = transport
        host.onNewStory = {
            Task {
                guard let data = await transport.postNew(), let event = try? JSONDecoder().decode(JSONValue.self, from: data) else { return }
                arrive.yield(.event(event))
            }
        }
        host.onEditDraft = { [weak host] in
            guard let host else { return }
            let drafts = session.snapshot.stories.values.filter { $0.status == .draft }
            guard let newest = drafts.max(by: { $0.updatedAt < $1.updatedAt }) else { return }
            StoriesEditorPresenter.present(session: session, draft: newest, from: host)
        }
        probe.accessibilityIdentifier = "stories-probe"
        probe.isAccessibilityElement = true
        probe.frame = CGRect(x: 0, y: 0, width: 1, height: 1)
        probe.alpha = 0.02
        host.view.addSubview(probe)
        window.rootViewController = host
        // A conversation's story card over home, on a draft of the person's.
        if arguments.contains("-storiesCard") {
            let card = StoriesHarnessCard(session: session)
            card.modalPresentationStyle = .fullScreen
            DispatchQueue.main.async { [weak host] in host?.present(card, animated: false) }
        }
        Task { await transport.drawFrames(Self.frames()) }
        Task { await transport.drawStickers(Self.stickers()) }
        watch = session.watch { [weak self] snapshot in
            guard let self else { return }
            self.snapshot = snapshot
        }
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.report() }
        }
        if arguments.contains("-storiesCompose") {
            Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(600))
                self?.compose()
            }
        }
    }

    private func compose() {
        let session = session
        let host = host
        Task { StoriesEditorPresenter.present(session: session, picked: await Self.picture(), from: host) }
    }

    /// The story's first picture: tall, with a grid to read placement by.
    static func picture() async -> [StoriesMediaChooser.Picked] {
        let size = CGSize(width: 1080, height: 1440)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: size, format: format).image { context in
            let gradient = CGGradient(colorsSpace: nil, colors: [UIColor.systemTeal.cgColor, UIColor.systemIndigo.cgColor] as CFArray, locations: [0, 1])!
            context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 0, y: size.height), options: [])
            UIColor(white: 1, alpha: 0.15).setFill()
            for x in stride(from: 0, to: size.width, by: 120) { context.fill(CGRect(x: x, y: 0, width: 2, height: size.height)) }
            for y in stride(from: 0, to: size.height, by: 120) { context.fill(CGRect(x: 0, y: y, width: size.width, height: 2)) }
            let text = NSAttributedString(string: "Picked", attributes: [.font: UIFont.systemFont(ofSize: 150, weight: .heavy), .foregroundColor: UIColor(white: 1, alpha: 0.85)])
            text.draw(at: CGPoint(x: (size.width - text.size().width) / 2, y: size.height * 0.6))
        }
        guard let data = image.pngData(), let picked = await StoriesMediaChooser.image(data, type: .png) else { return [] }
        return [picked]
    }

    /// The editor, under whatever it shows (the picker, a sheet).
    private var editor: StoryEditorViewController? {
        var shown = host.presentedViewController
        while let controller = shown {
            if let editor = controller as? StoryEditorViewController { return editor }
            shown = controller.presentedViewController
        }
        return nil
    }

    /// What the row remembers of being put away, for the probe.
    private static var putAway: String {
        guard let value = UserDefaults.standard.dictionary(forKey: StoriesHomeController.putAwayKey)?["stories-harness"] as? NSNumber else { return "none" }
        return value.int64Value == .max ? "always" : String(value.int64Value)
    }

    private func report() {
        // Over everything, so a full-screen editor doesn't take it away.
        if probe.superview !== window { window.addSubview(probe) }
        window.bringSubviewToFront(probe)
        // The harness's own stories (`d1` is the story card's draft) aren't made here.
        let made = snapshot.stories.values.filter { !["m1", "s1", "s2", "a1", "a2", "d1"].contains($0.id) && !$0.id.hasPrefix("new-") }
            .sorted { $0.createdAt < $1.createdAt }
            .map { "\($0.status.rawValue):\($0.artifactVersion):\($0.frames.first?.overlays.count ?? 0)" }.joined(separator: ",")
        if let editor {
            let overlays = editor.draft.current?.overlays ?? []
            let kinds = overlays.map { overlay -> String in
                switch overlay {
                case .text: "text"
                case .link: "link"
                case .sticker: "sticker"
                case .emoji: "emoji"
                case .reaction: "reaction"
                case .unknown: "unknown"
                }
            }
            let top = overlays.last?.transform.map { String(format: "%.3f,%.3f,%.2f,%.3f", $0.x, $0.y, $0.scale, $0.rotation) } ?? "nil"
            probe.accessibilityValue = "editor=1 frames=\(editor.draft.frames.count) selected=\(editor.draft.selected) overlays=\(kinds.joined(separator: ",")) top=\(top) trail=\(editor.trail.joined(separator: ";")) saved=\(made) haptics=\(recorder.played.joined(separator: ","))"
            return
        }
        if let card = host.presentedViewController as? StoriesHarnessCard {
            let viewer = card.presentedViewController is StoryViewerViewController
            probe.accessibilityValue = "card=\(card.state) viewer=\(viewer ? 1 : 0)"
            return
        }
        guard let viewer = host.presentedViewController as? StoryViewerViewController else {
            let count = snapshot.feed?.authors.reduce(0) { $0 + $1.storyIds.count } ?? 0
            probe.accessibilityValue = "viewer=0 editor=0 header=\(host.stories.unlocked ? "open" : "closed") putAway=\(Self.putAway) stories=\(count) title=\(host.titleX) saved=\(made) haptics=\(recorder.played.joined(separator: ","))"
            return
        }
        let reaction = viewer.current?.story.myReaction ?? "nil"
        let sound = viewer.currentPage.soundButton.isHidden ? "none" : viewer.currentPage.soundButton.accessibilityValue ?? "none"
        probe.accessibilityValue = "viewer=1 author=\(viewer.authorIndex) position=\(viewer.position) paused=\(viewer.isPaused ? 1 : 0) sound=\(sound) muted=\(viewer.currentPage.canvas.player?.isMuted == true ? 1 : 0) chrome=\(viewer.currentPage.chromeHidden ? 0 : 1) reaction=\(reaction) trail=\(viewer.trail.joined(separator: ",")) haptics=\(recorder.played.joined(separator: ","))"
    }

    /// The harness packs' files: each a shape in its colour, and the
    /// animated one its Lottie (as `?as=lottie` serves a `tgs`).
    static func stickers() -> [String: Data] {
        var files: [String: Data] = [:]
        for pack in StoriesHarnessTransport.packs {
            for sticker in pack.stickers {
                if sticker.shape == "lottie" {
                    files["\(pack.id)/\(sticker.id)"] = Data(spinLottie.utf8)
                    continue
                }
                let size = CGSize(width: 256, height: 256)
                let format = UIGraphicsImageRendererFormat()
                format.scale = 1
                format.opaque = false
                let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in
                    sticker.color.setFill()
                    let box = CGRect(x: 24, y: 24, width: 208, height: 208)
                    switch sticker.shape {
                    case "circle": UIBezierPath(ovalIn: box).fill()
                    case "star":
                        let path = UIBezierPath()
                        for point in 0..<10 {
                            let radius: CGFloat = point % 2 == 0 ? 104 : 44
                            let angle = CGFloat(point) * .pi / 5 - .pi / 2
                            let at = CGPoint(x: 128 + radius * cos(angle), y: 128 + radius * sin(angle))
                            if point == 0 { path.move(to: at) } else { path.addLine(to: at) }
                        }
                        path.close()
                        path.fill()
                    case "heart":
                        UIBezierPath(ovalIn: CGRect(x: 30, y: 40, width: 110, height: 110)).fill()
                        UIBezierPath(ovalIn: CGRect(x: 116, y: 40, width: 110, height: 110)).fill()
                        let tip = UIBezierPath()
                        tip.move(to: CGPoint(x: 36, y: 118)); tip.addLine(to: CGPoint(x: 220, y: 118)); tip.addLine(to: CGPoint(x: 128, y: 226)); tip.close()
                        tip.fill()
                    default: UIBezierPath(roundedRect: box, cornerRadius: 36).fill()
                    }
                }
                files["\(pack.id)/\(sticker.id)"] = image.pngData()
            }
        }
        return files
    }

    /// A pink rounded square that turns and breathes, with a white dot to
    /// see it turn: the one `scripts/generate-test-sticker-packs.py` writes.
    static let spinLottie = #"""
{"v":"5.7.4","fr":30,"ip":0,"op":60,"w":512,"h":512,"nm":"spin","ddd":0,"assets":[],"layers":[{"ddd":0,"ind":1,"ty":4,"nm":"spin","sr":1,"ao":0,"ip":0,"op":60,"st":0,"bm":0,"ks":{"o":{"a":0,"k":100},"r":{"a":1,"k":[{"t":0,"s":[0],"i":{"x":[0.5],"y":[1]},"o":{"x":[0.5],"y":[0]}},{"t":60,"s":[360]}]},"p":{"a":0,"k":[256,256,0]},"a":{"a":0,"k":[0,0,0]},"s":{"a":1,"k":[{"t":0,"s":[100,100,100],"i":{"x":[0.5,0.5,0.5],"y":[1,1,1]},"o":{"x":[0.5,0.5,0.5],"y":[0,0,0]}},{"t":30,"s":[70,70,100],"i":{"x":[0.5,0.5,0.5],"y":[1,1,1]},"o":{"x":[0.5,0.5,0.5],"y":[0,0,0]}},{"t":60,"s":[100,100,100]}]}},"shapes":[{"ty":"gr","nm":"dot","it":[{"ty":"el","nm":"e","d":1,"s":{"a":0,"k":[70,70]},"p":{"a":0,"k":[0,-90]}},{"ty":"fl","nm":"f","c":{"a":0,"k":[1,1,1,1]},"o":{"a":0,"k":100},"r":1},{"ty":"tr","p":{"a":0,"k":[0,0]},"a":{"a":0,"k":[0,0]},"s":{"a":0,"k":[100,100]},"r":{"a":0,"k":0},"o":{"a":0,"k":100}}]},{"ty":"gr","nm":"square","it":[{"ty":"rc","nm":"r","d":1,"s":{"a":0,"k":[300,300]},"p":{"a":0,"k":[0,0]},"r":{"a":0,"k":80}},{"ty":"fl","nm":"f","c":{"a":0,"k":[1,0.216,0.373,1]},"o":{"a":0,"k":100},"r":1},{"ty":"tr","p":{"a":0,"k":[0,0]},"a":{"a":0,"k":[0,0]},"s":{"a":0,"k":[100,100]},"r":{"a":0,"k":0},"o":{"a":0,"k":100}}]}]}]}
"""#

    /// Every frame's picture: a gradient, its name large, bands to read
    /// placement by.
    static func frames() -> [String: Data] {
        let names: [(String, UIColor, UIColor, CGSize)] = [
            ("f-m1a", .systemIndigo, .systemTeal, CGSize(width: 720, height: 1280)),
            ("f-m1b", .systemOrange, .systemPink, CGSize(width: 1280, height: 720)),
            ("f-s1", .systemGreen, .systemBlue, CGSize(width: 720, height: 1280)),
            ("f-s2", .systemPurple, .systemRed, CGSize(width: 720, height: 1280)),
            ("f-a1", .systemYellow, .systemBrown, CGSize(width: 720, height: 1280)),
            ("f-d1", .systemTeal, .systemIndigo, CGSize(width: 720, height: 1280)),
        ]
        var frames: [String: Data] = [:]
        for (name, top, bottom, size) in names {
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            let image = UIGraphicsImageRenderer(size: size, format: format).image { context in
                let gradient = CGGradient(colorsSpace: nil, colors: [top.cgColor, bottom.cgColor] as CFArray, locations: [0, 1])!
                context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 0, y: size.height), options: [])
                UIColor(white: 1, alpha: 0.12).setFill()
                for y in stride(from: 0, to: size.height, by: 160) { context.fill(CGRect(x: 0, y: y, width: size.width, height: 80)) }
                let text = NSAttributedString(string: name, attributes: [.font: UIFont.systemFont(ofSize: size.width / 7, weight: .heavy), .foregroundColor: UIColor(white: 1, alpha: 0.85)])
                let measured = text.size()
                text.draw(at: CGPoint(x: (size.width - measured.width) / 2, y: size.height * 0.55))
            }
            frames[name] = image.pngData()
        }
        return frames
    }
}

/// Writes down each moment as the app plays it.
@MainActor
final class StoriesHarnessHaptics {
    private(set) var played: [String] = []

    init() {
        StoriesHaptics.onPlay = { [weak self] moment in
            guard let self else { return }
            played.append("\(moment)")
            if played.count > 16 { played.removeFirst() }
        }
    }
}

/// The harness's computer: Stories on, three authors, reactions and seen
/// marks kept as the daemon keeps them.
actor StoriesHarnessTransport: DirectTransport {
    private var stories: [String: [String: Any]] = [:]
    private var frames: [String: Data] = [:]
    private var order = ["self": ["m1"], "u2": ["s1", "s2"], "u3": ["a1"]]
    /// Ana's story as two recordings, the first with sound, the second
    /// without (`-storiesVideo`).
    private let videos: Bool
    private var uploads: [String: Data] = [:]
    private var recents: [[String: Any]] = []
    private var stickerFiles: [String: Data] = [:]
    private var revision = 0

    /// Two tiny packs drawn here: shapes for the Stickers tab, and glyphs
    /// of kind emoji. Their files are PNGs under the `webp` name, which
    /// ImageIO reads by their bytes the same.
    static let packs: [(id: String, title: String, kind: String, stickers: [(id: String, emoji: String, color: UIColor, shape: String)])] = [
        ("shapes", "Shapes", "stickers", [
            ("circle", "🔵", .systemBlue, "circle"), ("square", "🟥", .systemRed, "square"), ("star", "⭐️", .systemYellow, "star"),
            ("heart", "❤️", .systemPink, "heart"), ("drop", "💧", .systemTeal, "circle"), ("leaf", "🍀", .systemGreen, "square"),
        ]),
        ("glyphs", "Glyphs", "emoji", [
            ("plus", "➕", .systemOrange, "square"), ("ring", "⭕️", .systemPurple, "circle"),
        ]),
        ("motion", "Motion", "stickers", [("spin", "🌀", .systemPink, "lottie")]),
    ]

    func drawStickers(_ files: [String: Data]) { stickerFiles = files }

    private func stickerObject(_ packId: String, _ sticker: (id: String, emoji: String, color: UIColor, shape: String)) -> [String: Any] {
        let size = stickerFiles["\(packId)/\(sticker.id)"]?.count ?? 1
        let animated = sticker.shape == "lottie"
        return ["packId": packId, "id": sticker.id, "emoji": [sticker.emoji], "format": animated ? "tgs" : "webp", "width": animated ? 512 : 256, "height": animated ? 512 : 256, "size": size,
                "sha256": String(repeating: "0", count: 56) + String(format: "%08x", abs("\(packId)/\(sticker.id)".hashValue) % 0xFFFFFFF)]
    }

    private func packObject(_ pack: (id: String, title: String, kind: String, stickers: [(id: String, emoji: String, color: UIColor, shape: String)])) -> [String: Any] {
        ["id": pack.id, "title": pack.title, "kind": pack.kind, "thumbnail": pack.stickers[0].id, "stickerCount": pack.stickers.count, "version": "1"]
    }

    private func json(_ body: Data?) -> [String: Any] {
        (body.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
    }

    /// A frame as the daemon keeps one sent by hand: its upload becomes a
    /// file of the story's artifact.
    private func made(_ input: [String: Any], storyId: String, kept: [String: Any]?) -> [String: Any]? {
        let id = input["id"] as? String ?? "f\(revision)"
        var frame = kept ?? ["id": id, "kind": "image", "width": NSNull(), "height": NSNull(), "thumbhash": NSNull(), "durationMs": NSNull(), "available": true,
                             "placement": ["x": 0.5, "y": 0.5, "scale": 1, "rotation": 0], "background": ["#203040", "#405060"], "overlays": [] as [Any]]
        if let upload = input["upload"] as? [String: Any], let uploadId = upload["uploadId"] as? String, let data = uploads.removeValue(forKey: uploadId) {
            frames[id] = data
            let image = UIImage(data: data)
            frame["width"] = image.map { Int($0.size.width * $0.scale) } ?? NSNull()
            frame["height"] = image.map { Int($0.size.height * $0.scale) } ?? NSNull()
            frame["asset"] = ["type": "artifact_file", "artifactId": storyId, "version": revision, "path": "media/\(id).png"]
        } else if let asset = input["asset"] {
            frame["asset"] = asset
        } else if kept == nil {
            return nil
        }
        for key in ["placement", "background", "overlays"] { if let value = input[key] { frame[key] = value } }
        return frame
    }

    /// `newer`: one more of Ana's, posted a minute after the rest.
    init(videos: Bool = false, epoch: Int64, newer: Bool = false) {
        self.videos = videos
        let now = epoch
        func frame(_ id: String, width: Int, height: Int, background: [String], overlays: [[String: Any]]) -> [String: Any] {
            ["id": id, "kind": "image", "width": width, "height": height, "thumbhash": NSNull(), "durationMs": NSNull(),
             "asset": ["type": "chat_media", "agentId": "a1", "toolCallId": "t1", "index": 0], "available": true,
             "placement": ["x": 0.5, "y": 0.5, "scale": 1, "rotation": 0], "background": background, "overlays": overlays]
        }
        func t(_ x: Double, _ y: Double, _ scale: Double = 1, _ rotation: Double = 0) -> [String: Any] { ["x": x, "y": y, "scale": scale, "rotation": rotation] }
        func text(_ id: String, _ string: String, fill: String, color: String, font: String = "sanFrancisco", _ transform: [String: Any]) -> [String: Any] {
            ["id": id, "type": "text", "text": string, "style": ["font": font, "fill": fill, "color": color, "align": "center", "width": 0.8], "transform": transform]
        }
        func story(_ id: String, author: String?, postedAgo minutes: Int64, frames: [[String: Any]], caption: String?, reactions: [[String: Any]] = [], viewCount: Any = NSNull()) -> [String: Any] {
            let posted = now - minutes * 60_000
            return ["id": id, "status": "posted", "authorUserId": (author as Any?) ?? NSNull(), "createdBy": ["kind": "user", "userId": (author as Any?) ?? NSNull()] as [String: Any],
                    "source": author == nil ? ["agentId": "a1", "toolCallId": "t1"] : NSNull(), "caption": (caption as Any?) ?? NSNull(), "frames": frames,
                    "audience": "team", "artifactVersion": 1, "createdAt": posted, "updatedAt": posted, "postedAt": posted, "expiresAt": posted + 86_400_000,
                    "seen": author == nil, "viewCount": viewCount, "myReaction": NSNull(), "reactions": reactions, "version": "0190-\(id)"]
        }
        stories["m1"] = story("m1", author: nil, postedAgo: 50, frames: [
            frame("f-m1a", width: 720, height: 1280, background: ["#202040", "#104050"], overlays: [
                text("o1", "Shipped the viewer", fill: "filled", color: "#FFFFFF", t(0.5, 0.2, 1.2)),
                ["id": "o2", "type": "link", "url": "https://happy.engineering", "label": NSNull(), "style": "white", "transform": t(0.5, 0.82)],
            ]),
            frame("f-m1b", width: 1280, height: 720, background: ["#F08030", "#F03080"], overlays: [
                ["id": "o3", "type": "emoji", "emoji": "🚀", "transform": t(0.25, 0.25, 0.25, -0.3)],
            ]),
        ], caption: "Two frames of mine", viewCount: 6)
        stories["s1"] = story("s1", author: "u2", postedAgo: 120, frames: [
            frame("f-s1", width: 720, height: 1280, background: ["#108040", "#1040A0"], overlays: [
                text("o4", "React to this", fill: "regular", color: "#FFFFFF", font: "typewriter", t(0.5, 0.25, 1.3)),
                ["id": "o5", "type": "reaction", "emoji": "🔥", "transform": t(0.7, 0.6, 0.28)],
            ]),
        ], caption: nil, reactions: [["emoji": "🔥", "count": 3]])
        stories["s2"] = story("s2", author: "u2", postedAgo: 90, frames: [
            frame("f-s2", width: 720, height: 1280, background: ["#602080", "#A02020"], overlays: [
                text("o6", "Second from Steve", fill: "semi", color: "#000000", font: "georgia", t(0.5, 0.3, 1.1, 0.1)),
            ]),
        ], caption: "Late night at the studio, finally got the last of the boulder problems set for the weekend comp. Six new routes on the overhang, two slabs that will humble everyone, and a dyno I am weirdly proud of. Huge thanks to Maya for holding the ladder for three hours straight and to whoever left the pizza in the break room. Doors open at nine, bring chalk, bring friends, and please stretch first this time.")
        stories["a1"] = story("a1", author: "u3", postedAgo: 30, frames: [
            frame("f-a1", width: 720, height: 1280, background: ["#C0A010", "#604020"], overlays: [
                text("o7", "Ana's story", fill: "stroke", color: "#2040FF", font: "noteworthy", t(0.5, 0.3, 1.4)),
            ]),
        ], caption: nil)
        if newer {
            stories["a2"] = story("a2", author: "u3", postedAgo: -1, frames: [
                frame("f-a1", width: 720, height: 1280, background: ["#C0A010", "#604020"], overlays: [
                    text("o9", "Ana's newer one", fill: "stroke", color: "#2040FF", font: "noteworthy", t(0.5, 0.3, 1.4)),
                ]),
            ], caption: nil)
            order["u3", default: []].append("a2")
        }
        // A draft of the person's, for the story card.
        var draft = story("d1", author: nil, postedAgo: 5, frames: [
            frame("f-d1", width: 720, height: 1280, background: ["#203040", "#405060"], overlays: [
                text("o8", "A draft", fill: "filled", color: "#FFFFFF", t(0.5, 0.25, 1.2)),
            ]),
        ], caption: "Drafted in a conversation")
        for key in ["postedAt", "expiresAt", "viewCount"] { draft[key] = NSNull() }
        draft["status"] = "draft"
        draft["seen"] = false
        stories["d1"] = draft
        if videos {
            func video(_ id: String) -> [String: Any] {
                var made = frame(id, width: 360, height: 640, background: ["#202020", "#000000"], overlays: [])
                made["kind"] = "video"
                made["durationMs"] = 3000
                return made
            }
            stories["a1"]?["frames"] = [video("f-a1-sound"), video("f-a1-silent")]
        }
    }

    func drawFrames(_ frames: [String: Data]) { self.frames = frames }

    /// Another of Ana's stories, posted now and unseen: the `story.posted`
    /// event that brings it, the feed already counting it.
    func postNew() -> Data? {
        guard var story = stories["a1"] else { return nil }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        revision += 1
        let id = "new-\(revision)"
        story["id"] = id
        story["postedAt"] = now
        story["createdAt"] = now
        story["updatedAt"] = now
        story["expiresAt"] = now + 86_400_000
        story["seen"] = false
        story["version"] = "v\(revision)"
        stories[id] = story
        order["u3", default: []].append(id)
        return try? JSONSerialization.data(withJSONObject: ["type": "story.posted", "payload": ["story": story]])
    }

    private func author(_ key: String) -> [String: Any] {
        let names = ["self": "Kirill Dubovitskiy", "u2": "Steve Korshakov", "u3": "Ana Lima"]
        let ids = order[key] ?? []
        let unseen = key == "self" ? 0 : ids.filter { (stories[$0]?["seen"] as? Bool) == false }.count
        let latest = ids.compactMap { stories[$0]?["postedAt"] as? Int64 }.max()
        return ["userId": key == "self" ? NSNull() as Any : key, "name": names[key] ?? key, "photo": NSNull(), "thumbhash": NSNull(),
                "isSelf": key == "self", "storyIds": ids, "unseenCount": unseen, "draftCount": key == "self" ? 0 : NSNull(), "latestPostedAt": (latest as Any?) ?? NSNull()]
    }

    private func ok(_ object: Any) -> DirectHTTPResponse {
        DirectHTTPResponse(status: 200, headers: ["content-type": "application/json"], body: (try? JSONSerialization.data(withJSONObject: object)) ?? Data())
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> DirectHTTPResponse {
        try await Task.sleep(for: .milliseconds(60))
        let route = String(path.split(separator: "?").first ?? "")
        // "-storiesSlowFrames": pictures take a while, as over a slow link.
        if route.contains("/frames/"), ProcessInfo.processInfo.arguments.contains("-storiesSlowFrames") {
            try await Task.sleep(for: .milliseconds(1500))
        }
        let parts = route.split(separator: "/").map(String.init)
        switch (method, route) {
        case ("GET", "/v0/health"):
            return ok(["ready": true, "capabilities": ["stories": true, "stickers": true]])
        case ("GET", _) where route.hasPrefix("/v0/user-settings/"):
            return ok(["setting": ["key": DirectAgentClient.storiesSettingKey, "value": true]])
        case ("GET", "/v0/stories/feed"):
            let keys = ["self", "u2", "u3"]
            return ok(["authors": keys.map(author), "stories": stories, "cursor": "c1"])
        case ("GET", "/v0/stickers/recents"):
            return ok(["recents": recents, "cursor": "c1"])
        case ("POST", "/v0/stickers/recents"):
            let body = json(body)
            let ref: [String: Any] = ["packId": body["packId"] as? String ?? "", "stickerId": body["stickerId"] as? String ?? ""]
            recents.removeAll { ($0["packId"] as? String) == (ref["packId"] as? String) && ($0["stickerId"] as? String) == (ref["stickerId"] as? String) }
            recents.insert(ref, at: 0)
            return ok(["recents": recents, "cursor": "c1"])
        case ("DELETE", "/v0/stickers/recents"):
            recents = []
            return ok(["recents": recents, "cursor": "c1"])
        case ("GET", "/v0/stickers/packs"):
            return ok(["packs": Self.packs.map(packObject)])
        case ("GET", "/v0/stickers/search"):
            let query = path.split(separator: "?").dropFirst().first.map(String.init) ?? ""
            let items = URLComponents(string: "?" + query)?.queryItems ?? []
            let emoji = items.first { $0.name == "emoji" }?.value
            let q = items.first { $0.name == "q" }?.value?.lowercased()
            let kind = items.first { $0.name == "kind" }?.value ?? "stickers"
            let found = Self.packs.filter { $0.kind == kind }.flatMap { pack in
                pack.stickers.filter { sticker in
                    if let emoji { return sticker.emoji == emoji }
                    if let q { return pack.title.lowercased().hasPrefix(q) }
                    return false
                }.map { stickerObject(pack.id, $0) }
            }
            return ok(["stickers": found])
        case ("POST", "/v0/artifact-uploads"):
            revision += 1
            let id = "u\(revision)"
            uploads[id] = body ?? Data()
            return DirectHTTPResponse(status: 201, headers: ["content-type": "application/json"], body: (try? JSONSerialization.data(withJSONObject: ["upload": ["id": id, "size": body?.count ?? 0, "sha256": "", "createdAt": 0, "expiresAt": 0]])) ?? Data())
        case ("POST", "/v0/stories"):
            let body = json(body)
            let id = body["id"] as? String ?? "made\(revision)"
            if let story = stories[id] { return DirectHTTPResponse(status: 201, headers: [:], body: (try? JSONSerialization.data(withJSONObject: ["story": story])) ?? Data()) }
            revision += 1
            let frames = (body["frames"] as? [[String: Any]] ?? []).compactMap { made($0, storyId: id, kept: nil) }
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            let story: [String: Any] = ["id": id, "status": "draft", "authorUserId": NSNull(), "createdBy": ["kind": "user", "userId": NSNull()] as [String: Any], "source": NSNull(),
                                        "caption": body["caption"] ?? NSNull(), "frames": frames, "audience": "self", "artifactVersion": 1, "createdAt": now, "updatedAt": now,
                                        "postedAt": NSNull(), "expiresAt": NSNull(), "seen": false, "viewCount": NSNull(), "myReaction": NSNull(), "reactions": [] as [Any], "version": "v\(revision)"]
            stories[id] = story
            return DirectHTTPResponse(status: 201, headers: ["content-type": "application/json"], body: (try? JSONSerialization.data(withJSONObject: ["story": story])) ?? Data())
        case ("GET", "/v0/stories"):
            let drafts = stories.values.filter { ($0["status"] as? String) == "draft" }
            return ok(["stories": drafts, "nextCursor": NSNull(), "cursor": "c1"])
        default:
            break
        }
        if parts.count >= 3, parts[1] == "stickers", parts[2] == "packs", parts.count >= 4, let pack = Self.packs.first(where: { $0.id == parts[3] }) {
            if parts.count == 4 { return ok(["pack": packObject(pack), "stickers": pack.stickers.map { stickerObject(pack.id, $0) }]) }
            if parts.count == 7, let sticker = pack.stickers.first(where: { $0.id == parts[5] }), let data = stickerFiles["\(pack.id)/\(sticker.id)"] {
                // A tgs is only ever served here as its Lottie, which the app must ask for.
                if sticker.shape == "lottie" {
                    guard path.contains("as=lottie") else { return DirectHTTPResponse(status: 406) }
                    return DirectHTTPResponse(status: 200, headers: ["content-type": "application/json"], body: data)
                }
                return DirectHTTPResponse(status: 200, headers: ["content-type": "image/webp"], body: data)
            }
            return DirectHTTPResponse(status: 404)
        }
        guard parts.count >= 3, parts[1] == "stories", var story = stories[parts[2]] else { return DirectHTTPResponse(status: 404) }
        let id = parts[2]
        switch (method, parts.count > 3 ? parts[3] : "") {
        case ("GET", ""):
            return ok(["story": story])
        case ("GET", "frames"):
            guard parts.count > 4 else { return DirectHTTPResponse(status: 404) }
            if videos, parts[4].hasPrefix("f-a1-") {
                if frames[parts[4]] == nil { frames[parts[4]] = await StoriesHarnessVideo.make(sound: parts[4] == "f-a1-sound") }
                guard let data = frames[parts[4]] else { return DirectHTTPResponse(status: 404) }
                return DirectHTTPResponse(status: 200, headers: ["content-type": "video/mp4"], body: data)
            }
            guard let data = frames[parts[4]] else { return DirectHTTPResponse(status: 404) }
            return DirectHTTPResponse(status: 200, headers: ["content-type": "image/png"], body: data)
        case ("GET", "viewers"):
            // As the API orders them: reactors by latest reaction, then the rest by name.
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            func viewer(_ id: String, _ name: String, _ reaction: String? = nil, minutesAgo: Int64 = 0) -> [String: Any] {
                ["userId": id, "name": name, "photo": NSNull(), "thumbhash": NSNull(),
                 "reaction": (reaction as Any?) ?? NSNull(), "reactedAt": reaction == nil ? NSNull() : now - minutesAgo * 60_000]
            }
            return ok(["viewers": [
                viewer("u2", "Steve Korshakov", "❤️", minutesAgo: 2),
                viewer("u4", "Maya Okafor", "🔥", minutesAgo: 14),
                viewer("u5", "Leo Brandt", "👍", minutesAgo: 1_700),
                viewer("u3", "Ana Lima"),
                viewer("u6", "Jonas Weber"),
                viewer("u7", "Priya Raman"),
            ], "nextCursor": NSNull()])
        case ("POST", "seen"):
            // Seen through this one: every earlier story of the author too.
            let author = story["authorUserId"] as? String
            let mark = story["postedAt"] as? Int64 ?? 0
            for (other, value) in stories where value["authorUserId"] as? String == author && (value["postedAt"] as? Int64 ?? 0) <= mark {
                stories[other]?["seen"] = true
            }
            return ok(["story": stories[id] ?? story])
        case ("PUT", "reaction"), ("DELETE", "reaction"):
            let emoji = method == "PUT" ? (try? JSONSerialization.jsonObject(with: body ?? Data()) as? [String: Any])?["emoji"] as? String : nil
            let old = story["myReaction"] as? String
            var counts = (story["reactions"] as? [[String: Any]] ?? []).map { ($0["emoji"] as? String ?? "", $0["count"] as? Int ?? 0) }
            if let old, let index = counts.firstIndex(where: { $0.0 == old }) { counts[index].1 -= 1 }
            if let emoji {
                if let index = counts.firstIndex(where: { $0.0 == emoji }) { counts[index].1 += 1 } else { counts.append((emoji, 1)) }
            }
            story["reactions"] = counts.filter { $0.1 > 0 }.sorted { $0.1 > $1.1 }.map { ["emoji": $0.0, "count": $0.1] }
            story["myReaction"] = (emoji as Any?) ?? NSNull()
            story["seen"] = true
            stories[id] = story
            return ok(["story": story])
        case ("POST", "delete"):
            story["status"] = "deleted"
            stories[id] = nil
            return ok(["story": story])
        case ("PATCH", ""):
            guard headers["If-Match"] == story["version"] as? String else { return DirectHTTPResponse(status: 409) }
            let body = json(body)
            revision += 1
            if let caption = body["caption"] { story["caption"] = caption }
            if let inputs = body["frames"] as? [[String: Any]] {
                let held = Dictionary((story["frames"] as? [[String: Any]] ?? []).map { ($0["id"] as? String ?? "", $0) }, uniquingKeysWith: { a, _ in a })
                story["frames"] = inputs.compactMap { made($0, storyId: id, kept: ($0["id"] as? String).flatMap { held[$0] }) }
            }
            story["artifactVersion"] = (story["artifactVersion"] as? Int ?? 1) + 1
            story["version"] = "v\(revision)"
            stories[id] = story
            return ok(["story": story])
        case ("POST", "post"):
            guard (story["status"] as? String) == "draft", (json(body)["artifactVersion"] as? Int) == story["artifactVersion"] as? Int else { return DirectHTTPResponse(status: 409) }
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            revision += 1
            story["status"] = "posted"
            story["postedAt"] = now
            story["expiresAt"] = now + 86_400_000
            story["seen"] = true
            story["viewCount"] = 0
            story["version"] = "v\(revision)"
            stories[id] = story
            order["self", default: []].append(id)
            return ok(["story": story])
        default:
            return DirectHTTPResponse(status: 404)
        }
    }

    func stream(path: String, credential: String, headers: [String: String]) async throws -> DirectHTTPStream {
        DirectHTTPStream(status: 503, body: AsyncThrowingStream { $0.finish() })
    }

    func reset() async {}
    func close() async {}
}

/// Home for the harness: Stem Cells home's header with the stories in it,
/// over a list of rows of its own, wired as `StemCellsHomeViewController`
/// wires its sidebar.
@MainActor
final class StoriesHarnessHome: UIViewController, UIScrollViewDelegate {
    private(set) lazy var stories = StoriesHomeController(host: self)
    private let header = HomeHeaderView()
    private let list = UIScrollView()
    private var rows: [UILabel] = []
    private let session: StoriesSession
    private var change: StoriesHomeController.Change?
    /// A draft's Edit, as a conversation's story card has it.
    var onEditDraft: (() -> Void)?
    private let editDraft = UIButton(type: .custom)
    /// Somebody posts a story while home is up.
    var onNewStory: (() -> Void)?
    private let newStory = UIButton(type: .custom)

    init(session: StoriesSession) {
        self.session = session
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// Where the header's title starts, rounded, for the probe.
    var titleX: String { String(format: "%.0f", header.titleLabel.frame.minX) }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.groupedBackground)
        list.contentInsetAdjustmentBehavior = .never
        list.alwaysBounceVertical = true
        list.delegate = self
        list.accessibilityIdentifier = "harness-list"
        view.addSubview(list)
        for index in 0..<30 {
            let row = UILabel()
            row.text = "  Session \(index + 1)"
            row.font = .systemFont(ofSize: 16)
            row.backgroundColor = UIColor(Palette.groupedBackground)
            rows.append(row)
            list.addSubview(row)
        }
        header.titleLabel.string = "Harness"
        header.status = .connected
        header.stemCellsActions = true
        view.addSubview(header)
        stories.onInsetChange = { [weak self] change in self?.moved(change) }
        stories.list = list
        stories.attach(session, images: session.images)
        stories.install(in: header)
        // The header's blurs are paused animations, which keep a UI test
        // waiting for the app to idle: without `-storiesBlur` the harness
        // goes without them.
        if !ProcessInfo.processInfo.arguments.contains("-storiesBlur") {
            func unblur(_ view: UIView) {
                for subview in view.subviews {
                    if subview is PartialBlurView { subview.removeFromSuperview() } else { unblur(subview) }
                }
            }
            unblur(header)
        }
        editDraft.accessibilityIdentifier = "harness-edit-draft"
        editDraft.backgroundColor = UIColor.black.withAlphaComponent(0.02)
        editDraft.addAction(UIAction { [weak self] _ in self?.onEditDraft?() }, for: .touchUpInside)
        view.addSubview(editDraft)
        newStory.accessibilityIdentifier = "harness-new-story"
        newStory.backgroundColor = UIColor.black.withAlphaComponent(0.02)
        newStory.addAction(UIAction { [weak self] _ in self?.onNewStory?() }, for: .touchUpInside)
        view.addSubview(newStory)
    }

    private func moved(_ change: StoriesHomeController.Change) {
        self.change = change
        defer { self.change = nil }
        view.setNeedsLayout()
        switch change {
        case .held, .immediate: view.layoutIfNeeded()
        case .animated:
            UIViewPropertyAnimator(duration: 0.3, controlPoint1: CGPoint(x: 0.33, y: 0.52), controlPoint2: CGPoint(x: 0.25, y: 0.99)) { [weak self] in
                self?.view.layoutIfNeeded()
            }.startAnimation()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let layout = HomeScreenLayout(size: view.bounds.size, safeArea: LayoutInsets(view.safeAreaInsets), dock: 0)
        header.frame = layout.header
        list.frame = view.bounds
        editDraft.frame = CGRect(x: 0, y: view.bounds.height - 60, width: 44, height: 44)
        newStory.frame = CGRect(x: view.bounds.width - 44, y: view.bounds.height - 60, width: 44, height: 44)
        for (index, row) in rows.enumerated() { row.frame = CGRect(x: 0, y: CGFloat(index) * 52, width: view.bounds.width, height: 51) }
        list.contentSize = CGSize(width: view.bounds.width, height: CGFloat(rows.count) * 52)
        let home = StemCellsHomeLayout(size: view.bounds.size, contentTop: layout.insets.contentTop, chromeTop: layout.insets.chromeTop, listBottom: layout.insets.listBottom, bannerHeight: 0, storiesHeight: stories.inset)
        let insets = UIEdgeInsets(home.listInsets)
        guard list.contentInset != insets else { return }
        let atTop = list.contentOffset.y <= -list.contentInset.top + 1
        list.contentInset = insets
        switch change {
        case .held: break
        case .animated: list.contentOffset.y = -insets.top
        case .immediate, nil: if atTop || (!list.isDragging && list.contentOffset.y < -insets.top) { list.contentOffset.y = -insets.top }
        }
    }

    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) { stories.listWillBeginDragging() }
    func scrollViewDidScroll(_ scrollView: UIScrollView) { stories.listDidScroll() }
    func scrollViewWillEndDragging(_ scrollView: UIScrollView, withVelocity velocity: CGPoint, targetContentOffset: UnsafeMutablePointer<CGPoint>) {
        stories.listWillEndDragging(target: targetContentOffset)
    }
    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        stories.listDidEndDragging(decelerate: decelerate)
    }
    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { stories.listDidEndDecelerating() }
}
/// A three second recording made here: colours going round under a
/// counter, with a 440 Hz tone or no sound track at all.
enum StoriesHarnessVideo {
    static func make(sound: Bool) async -> Data? {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("stories-harness-\(sound ? "sound" : "silent")-\(UUID().uuidString).mp4")
        defer { try? FileManager.default.removeItem(at: url) }
        guard let writer = try? AVAssetWriter(outputURL: url, fileType: .mp4) else { return nil }
        let size = CGSize(width: 360, height: 640)
        let video = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: size.width, AVVideoHeightKey: size.height,
        ])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: video, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: size.width, kCVPixelBufferHeightKey as String: size.height,
        ])
        writer.add(video)
        let rate = 44_100.0
        var audio: AVAssetWriterInput?
        if sound {
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: rate, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64_000,
            ])
            writer.add(input)
            audio = input
        }
        guard writer.startWriting() else { return nil }
        writer.startSession(atSourceTime: .zero)
        let fps: Int32 = 15
        let seconds = 3
        for index in 0..<(Int(fps) * seconds) {
            while !video.isReadyForMoreMediaData { try? await Task.sleep(for: .milliseconds(5)) }
            guard let pool = adaptor.pixelBufferPool else { return nil }
            var buffer: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer)
            guard let buffer else { return nil }
            CVPixelBufferLockBaseAddress(buffer, [])
            if let context = CGContext(data: CVPixelBufferGetBaseAddress(buffer), width: Int(size.width), height: Int(size.height), bitsPerComponent: 8,
                                       bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: CGColorSpaceCreateDeviceRGB(),
                                       bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) {
                let hue = CGFloat(index) / CGFloat(Int(fps) * seconds)
                context.setFillColor(UIColor(hue: hue, saturation: 0.6, brightness: 0.8, alpha: 1).cgColor)
                context.fill(CGRect(origin: .zero, size: size))
                UIGraphicsPushContext(context)
                context.translateBy(x: 0, y: size.height)
                context.scaleBy(x: 1, y: -1)
                let label = NSAttributedString(string: "\(sound ? "sound" : "silent") \(index / Int(fps) + 1)", attributes: [
                    .font: UIFont.systemFont(ofSize: 44, weight: .heavy), .foregroundColor: UIColor.white,
                ])
                label.draw(at: CGPoint(x: (size.width - label.size().width) / 2, y: size.height * 0.45))
                UIGraphicsPopContext()
            }
            CVPixelBufferUnlockBaseAddress(buffer, [])
            adaptor.append(buffer, withPresentationTime: CMTime(value: CMTimeValue(index), timescale: fps))
            // The sound alongside, a frame's worth at a time, so the two interleave.
            if let audio {
                let chunk = Int(rate) / Int(fps)
                while !audio.isReadyForMoreMediaData { try? await Task.sleep(for: .milliseconds(5)) }
                guard let samples = tone(start: index * chunk, count: chunk, rate: rate) else { return nil }
                audio.append(samples)
            }
        }
        video.markAsFinished()
        audio?.markAsFinished()
        await writer.finishWriting()
        guard writer.status == .completed else { return nil }
        return try? Data(contentsOf: url)
    }

    /// `count` 16-bit mono samples of a quiet 440 Hz sine from `start`.
    private static func tone(start: Int, count: Int, rate: Double) -> CMSampleBuffer? {
        var description = AudioStreamBasicDescription(
            mSampleRate: rate, mFormatID: kAudioFormatLinearPCM, mFormatFlags: kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
            mBytesPerPacket: 2, mFramesPerPacket: 1, mBytesPerFrame: 2, mChannelsPerFrame: 1, mBitsPerChannel: 16, mReserved: 0
        )
        var format: CMAudioFormatDescription?
        guard CMAudioFormatDescriptionCreate(allocator: nil, asbd: &description, layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &format) == noErr,
              let format else { return nil }
        var samples = (0..<count).map { Int16(sin(2 * .pi * 440 * Double(start + $0) / rate) * 6_000) }
        var block: CMBlockBuffer?
        let bytes = count * 2
        guard CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: bytes, blockAllocator: nil, customBlockSource: nil, offsetToData: 0, dataLength: bytes, flags: 0, blockBufferOut: &block) == noErr,
              let block else { return nil }
        samples.withUnsafeMutableBytes { raw in _ = CMBlockBufferReplaceDataBytes(with: raw.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: bytes) }
        var buffer: CMSampleBuffer?
        guard CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: nil, dataBuffer: block, formatDescription: format, sampleCount: count,
                                                                   presentationTimeStamp: CMTime(value: CMTimeValue(start), timescale: CMTimeScale(rate)),
                                                                   packetDescriptions: nil, sampleBufferOut: &buffer) == noErr else { return nil }
        return buffer
    }
}
/// A conversation's story card alone (`-storiesCard`), on the draft d1:
/// Post, a delete as the viewer's would make, and the viewer it opens.
final class StoriesHarnessCard: UIViewController, StoriesProviding {
    let session: StoriesSession
    var stories: StoriesSession? { session }
    private let card = StoryInlineView()
    private let delete = UIButton(type: .custom)

    init(session: StoriesSession) {
        self.session = session
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// What the card shows, for the probe.
    var state: String { card.accessibilityValue?.split(separator: "#").first.map(String.init) ?? "none" }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.groupedBackground)
        view.addSubview(card)
        card.apply("d1")
        delete.accessibilityIdentifier = "harness-delete-card"
        delete.backgroundColor = UIColor.black.withAlphaComponent(0.02)
        let session = session
        delete.addAction(UIAction { _ in
            let store = session.store
            Task { try? await store.delete("d1") }
        }, for: .touchUpInside)
        view.addSubview(delete)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let size = StoryCardLayout.size(width: view.bounds.width - 32)
        card.frame = CGRect(origin: CGPoint(x: 16, y: view.safeAreaInsets.top + 24), size: size)
        delete.frame = CGRect(x: view.bounds.width - 44, y: view.bounds.height - 60, width: 44, height: 44)
    }
}
#endif
