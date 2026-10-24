#if canImport(UIKit) && (DEBUG || HAPPY_FIXTURES)
@testable import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit

/// Stories over a computer of the harness's own (`-screen stories`): three
/// authors, one of them the person, with pictures drawn here, so the UI
/// tests can drive the viewer with a finger where a standalone daemon has
/// nobody else's stories to show: the cube between authors, reactions, the
/// heart's other emoji.
///
/// `stories-probe`'s accessibility value reports the viewer:
/// `viewer=1 author=1 position=0 paused=0 chrome=1 reaction=🔥 haptics=open,react`.
@MainActor
final class StoriesHarness {
    private let window: UIWindow
    private let transport = StoriesHarnessTransport()
    private let session: StoriesSession
    private let host = UIViewController()
    private let row = StoriesRowView()
    private let probe = UILabel()
    private let recorder = StoriesHarnessHaptics()
    private var watch: StemCellsWatch?
    private var snapshot = StoriesSnapshot()
    private var timer: Timer?

    init(window: UIWindow) {
        self.window = window
        let arguments = ProcessInfo.processInfo.arguments
        if let index = arguments.firstIndex(of: "-storiesShowScale"), arguments.indices.contains(index + 1), let scale = Double(arguments[index + 1]) {
            StoryViewerViewController.showScale = scale
        }
        let client = DirectAgentClient(transport: transport, token: "harness")
        session = StoriesSession(accountID: "stories-harness", client: client, images: StemCellsImages(client: client), offline: nil) {
            AsyncStream { _ in }
        }
        host.view.backgroundColor = .systemGroupedBackground
        host.view.addSubview(row)
        probe.accessibilityIdentifier = "stories-probe"
        probe.isAccessibilityElement = true
        probe.frame = CGRect(x: 0, y: 0, width: 1, height: 1)
        probe.alpha = 0.02
        host.view.addSubview(probe)
        row.onOpen = { [weak self] item in self?.open(item) }
        window.rootViewController = host
        Task { await transport.drawFrames(Self.frames()) }
        watch = session.watch { [weak self] snapshot in
            guard let self else { return }
            self.snapshot = snapshot
            row.apply(StoriesRow.items(snapshot.feed, myStory: Strings.Stories.myStory))
            layout()
        }
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.report() }
        }
    }

    private func layout() {
        let top = window.safeAreaInsets.top + 20
        row.frame = CGRect(x: 0, y: top, width: host.view.bounds.width, height: StoriesRowLayout.Metrics.height)
    }

    private func open(_ item: StoriesRowItem) {
        guard let feed = snapshot.feed, let index = feed.authors.firstIndex(where: { $0.key == item.id }) else { return }
        StoriesViewerPresenter.present(session: session, feed: feed, authorIndex: index, from: host, origin: row.circle(item.id))
    }

    private func report() {
        layout()
        guard let viewer = host.presentedViewController as? StoryViewerViewController else {
            probe.accessibilityValue = "viewer=0 haptics=\(recorder.played.joined(separator: ","))"
            return
        }
        let reaction = viewer.current?.story.myReaction ?? "nil"
        probe.accessibilityValue = "viewer=1 author=\(viewer.authorIndex) position=\(viewer.position) paused=\(viewer.isPaused ? 1 : 0) chrome=\(viewer.currentPage.chromeHidden ? 0 : 1) reaction=\(reaction) trail=\(viewer.trail.joined(separator: ",")) haptics=\(recorder.played.joined(separator: ","))"
    }

    /// Every frame's picture: a gradient, its name large, bands to read
    /// placement by.
    static func frames() -> [String: Data] {
        let names: [(String, UIColor, UIColor, CGSize)] = [
            ("f-m1a", .systemIndigo, .systemTeal, CGSize(width: 720, height: 1280)),
            ("f-m1b", .systemOrange, .systemPink, CGSize(width: 1280, height: 720)),
            ("f-s1", .systemGreen, .systemBlue, CGSize(width: 720, height: 1280)),
            ("f-s2", .systemPurple, .systemRed, CGSize(width: 720, height: 1280)),
            ("f-a1", .systemYellow, .systemBrown, CGSize(width: 720, height: 1280)),
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
    private let order = ["self": ["m1"], "u2": ["s1", "s2"], "u3": ["a1"]]

    init() {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
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
        ], caption: "Two frames of mine", viewCount: 2)
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
        ], caption: "Late night")
        stories["a1"] = story("a1", author: "u3", postedAgo: 30, frames: [
            frame("f-a1", width: 720, height: 1280, background: ["#C0A010", "#604020"], overlays: [
                text("o7", "Ana's story", fill: "stroke", color: "#2040FF", font: "noteworthy", t(0.5, 0.3, 1.4)),
            ]),
        ], caption: nil)
    }

    func drawFrames(_ frames: [String: Data]) { self.frames = frames }

    private func author(_ key: String) -> [String: Any] {
        let names = ["self": "Kirill Dubovitskiy", "u2": "Steve Korshakov", "u3": "Ana Lima"]
        let ids = order[key] ?? []
        let unseen = key == "self" ? 0 : ids.filter { (stories[$0]?["seen"] as? Bool) == false }.count
        return ["userId": key == "self" ? NSNull() as Any : key, "name": names[key] ?? key, "photo": NSNull(), "thumbhash": NSNull(),
                "isSelf": key == "self", "storyIds": ids, "unseenCount": unseen, "draftCount": key == "self" ? 0 : NSNull(), "latestPostedAt": NSNull()]
    }

    private func ok(_ object: Any) -> DirectHTTPResponse {
        DirectHTTPResponse(status: 200, headers: ["content-type": "application/json"], body: (try? JSONSerialization.data(withJSONObject: object)) ?? Data())
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> DirectHTTPResponse {
        try await Task.sleep(for: .milliseconds(60))
        let route = String(path.split(separator: "?").first ?? "")
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
            return ok(["recents": [], "cursor": "c1"])
        default:
            break
        }
        guard parts.count >= 3, parts[1] == "stories", var story = stories[parts[2]] else { return DirectHTTPResponse(status: 404) }
        let id = parts[2]
        switch (method, parts.count > 3 ? parts[3] : "") {
        case ("GET", ""):
            return ok(["story": story])
        case ("GET", "frames"):
            guard parts.count > 4, let data = frames[parts[4]] else { return DirectHTTPResponse(status: 404) }
            return DirectHTTPResponse(status: 200, headers: ["content-type": "image/png"], body: data)
        case ("GET", "viewers"):
            return ok(["viewers": [
                ["userId": "u2", "name": "Steve Korshakov", "photo": NSNull(), "thumbhash": NSNull(), "reaction": "❤️", "reactedAt": 1],
                ["userId": "u3", "name": "Ana Lima", "photo": NSNull(), "thumbhash": NSNull(), "reaction": NSNull(), "reactedAt": NSNull()],
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
#endif
