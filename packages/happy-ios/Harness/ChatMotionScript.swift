#if (DEBUG || HAPPY_FIXTURES) && canImport(UIKit)
@testable import HappyUI
import UIKit

/// QA only (`-qaScript <name>`): drives the chat from inside the app, for
/// runs without UI automation. Steps go through the same paths a person's
/// would: the composer's text view takes the text as typed, its primary
/// button's action sends, a row's retry is the list's own action. Each
/// step's media time goes to `Documents/qa/<run>-script.jsonl`, next to
/// the probe's `-qaRows` trace.
///
/// - `send`: the keyboard up, two sends a reply streams after, a third that
///   fails, its retry, then the keyboard down.
/// - `live`: nothing; the live fixture's reply streams on its own.
///
/// `-qaFilm` also snapshots the window as it is on screen about 30 times a
/// second, to `Documents/qa/<run>-film/<media time>.jpg`, for a recording
/// where UI automation can't make one. Snapshots cost main-thread time:
/// take frame timings from a run without it.
@MainActor
final class ChatMotionScript {
    private weak var chat: ChatViewController?
    private let name: String
    private let url: URL?
    private var task: Task<Void, Never>?
    private var film: CADisplayLink?
    private var filmDirectory: URL?
    private let encoder = DispatchQueue(label: "happy.chat-motion.film", qos: .utility)

    init(chat: ChatViewController, name: String, run: String) {
        self.chat = chat
        self.name = name
        let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?.appendingPathComponent("qa")
        if let directory { try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true) }
        url = directory?.appendingPathComponent("\(run)-script.jsonl")
        if let url { try? Data().write(to: url) }
        if ProcessInfo.processInfo.arguments.contains("-qaFilm"), let directory {
            let film = directory.appendingPathComponent("\(run)-film")
            try? FileManager.default.removeItem(at: film)
            try? FileManager.default.createDirectory(at: film, withIntermediateDirectories: true)
            filmDirectory = film
            let link = CADisplayLink(target: self, selector: #selector(shoot))
            link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 30, preferred: 30)
            link.add(to: .main, forMode: .common)
            self.film = link
        }
        task = Task { [weak self] in await self?.run() }
    }

    @objc private func shoot(_ link: CADisplayLink) {
        guard let window = chat?.view.window, let filmDirectory else { return }
        let time = CACurrentMediaTime()
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
            _ = window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
        }
        encoder.async {
            guard let data = image.jpegData(compressionQuality: 0.7) else { return }
            try? data.write(to: filmDirectory.appendingPathComponent(String(format: "%.4f.jpg", time)))
        }
    }

    private func mark(_ event: String) {
        guard let url, let handle = try? FileHandle(forWritingTo: url) else { return }
        _ = try? handle.seekToEnd()
        try? handle.write(contentsOf: Data(String(format: "{\"t\":%.6f,\"event\":\"%@\"}\n", CACurrentMediaTime(), event).utf8))
        try? handle.close()
    }

    private func sleep(_ seconds: Double) async { try? await Task.sleep(for: .milliseconds(Int(seconds * 1000))) }

    private func view<T: UIView>(_ type: T.Type) -> T? {
        guard let root = chat?.view else { return nil }
        var stack = [root]
        while let view = stack.popLast() {
            if let match = view as? T { return match }
            stack.append(contentsOf: view.subviews)
        }
        return nil
    }

    private func run() async {
        // Until the rows are drawn.
        for _ in 0..<300 {
            if let list = view(ChatListView.self), list.isDisplayReady, !list.plans.isEmpty { break }
            await sleep(0.1)
        }
        await sleep(1.5)
        mark("ready")
        guard name == "send", let card = view(AgentInputCardView.self) else {
            await sleep(10)
            mark("done")
            film?.invalidate()
            film = nil
            return
        }
        mark("focus")
        card.textView.becomeFirstResponder()
        await sleep(2)
        await send("Walk me through the anchor", card: card, then: 9)
        await send("And once more, shorter", card: card, then: 9)
        await send("This one should fail", card: card, then: 3)
        if let list = view(ChatListView.self), let localId = failedLocalId(list) {
            mark("retry")
            chat?.chatList(list, perform: .retry(localId: localId))
            await sleep(9)
        } else {
            mark("no-retry")
        }
        mark("dismiss")
        card.textView.resignFirstResponder()
        await sleep(2)
        mark("done")
        film?.invalidate()
        film = nil
    }

    private func send(_ text: String, card: AgentInputCardView, then seconds: Double) async {
        card.textView.insertText(text)
        await sleep(0.6)
        mark("send")
        card.delegate?.agentInputCardDidPressPrimary(card)
        await sleep(seconds)
    }

    private func failedLocalId(_ list: ChatListView) -> String? {
        for plan in list.plans {
            for hit in plan.hits {
                if case .retry(let localId) = hit.action { return localId }
            }
        }
        return nil
    }
}
#endif
