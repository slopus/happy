#if canImport(UIKit)
import Foundation
import HappyCore
@testable import HappyUI
import UIKit

/// Developer › Last voice call transcript (`-screen callTranscript`) over a
/// made-up call recorded through the real `CallTranscript`, for
/// screenshots; `-empty` shows it before any call, `-bottom` its end.
/// Nothing connects.
@MainActor
final class CallTranscriptHarness {
    private final class Silent: CallConnection {
        func end() async {}
        func setMuted(_ muted: Bool) async throws {}
        func update(_ context: String) async throws {}
        func cue(_ facts: String) async throws {}
    }

    init(window: UIWindow, arguments: [String]) {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("call-transcript.jsonl")
        try? FileManager.default.removeItem(at: url)
        let store = FileCallTranscriptStore(url: url)
        let settings = UIViewController()
        settings.title = "Settings"
        settings.view.backgroundColor = .systemBackground
        let navigation = UINavigationController(rootViewController: settings)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        window.rootViewController = navigation
        Task {
            if !arguments.contains("-empty") { await Self.record(CallTranscript(store: store)) }
            let screen = CallTranscriptViewController(store: store)
            navigation.pushViewController(screen, animated: false)
            guard arguments.contains("-bottom") else { return }
            try? await Task.sleep(for: .seconds(1))
            let rows = screen.tableView.numberOfRows(inSection: 0)
            screen.tableView.scrollToRow(at: IndexPath(row: rows - 1, section: 0), at: .bottom, animated: false)
        }
    }

    private static func record(_ transcript: CallTranscript) async {
        var given: CallEvents?
        let events = CallEvents(activity: { _, _ in }, disconnected: {}, hungUp: {}, tool: { _ in
            CallToolResult(text: #"{"ok":true,"ref":"s3","title":"Ship the cache","status":"idle","lastMessage":"Benchmarks are in: 38% fewer reads."}"#)
        })
        let context = "Time: 14:02, Tuesday 17 November. focusRevision 4\n\nOn screen: Ship the cache (s3)\n\nConversations:\n- s1 Release notes\n- s3 Ship the cache\n  - s31 Measure the hit rate"
        guard let connection = try? await transcript.record({ _, _, events in given = events; return Silent() })(
            CallGrant(agentId: "fixture"), CallStart(context: context), events), let given else { return }
        given.said("Hi! What would you like to check?", 1)
        given.heard("How is the cache task doing?")
        _ = await given.tool(CallToolCall(id: "t1", name: "readConversation", parameters: Data(#"{"ref":"s3"}"#.utf8)))
        given.said("Ship the cache is idle; its last message says the benchmarks show 38% fewer reads.", 2)
        try? await connection.update(#"{"event":"assistant_text","title":"Release notes","ref":"s1","text":"Drafted the notes.","finishedTurn":true}"#)
        try? await connection.update(#"{"event":"unfollowed","title":"Fixture task 12","ref":"s12","reason":"no longer among the ten last visited"}"#)
        given.heard("Thanks, that's all.")
        given.said("Talk soon!", 3)
        await connection.end()
    }
}
#endif
