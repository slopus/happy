#if canImport(UIKit) && (DEBUG || HAPPY_FIXTURES)
import Foundation
@testable import HappyCore
@testable import HappyUI
import HappyWire
import UIKit

/// The Feed over a real Happy Agent daemon, reached as a phone reaches
/// one (`-screen realFeed -pair <happy://direct?…>`): it pairs through
/// the mobile connector, confirming its side of the emoji (the desktop's
/// is confirmed through the daemon's API), and opens the Feed. While it
/// is open, the desktop renames a task (`-task` to `-renamed`) and
/// retitles an artifact (`-artifact` to `-retitled`); the script waits
/// for each row to follow and notes which rows the change redrew. Shots
/// and `report.json` go to `Documents/real-feed/` for `devicectl`.
@MainActor
final class RealFeedHarness {
    private var account: AccountController?

    init(window: UIWindow, arguments: [String]) {
        Task { await open(window: window, arguments: arguments) }
    }

    private static func value(_ name: String, _ arguments: [String]) -> String? {
        arguments.firstIndex(of: name).flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil }
    }

    private func open(window: UIWindow, arguments: [String]) async {
        let script = RealFeedScript(window: window, names: (
            task: Self.value("-task", arguments) ?? "New Task", renamed: Self.value("-renamed", arguments) ?? "",
            artifact: Self.value("-artifact", arguments) ?? "", retitled: Self.value("-retitled", arguments) ?? ""
        ))
        do {
            guard let code = Self.value("-pair", arguments) else { return script.fail("no -pair code") }
            let link = try PairingLink(code)
            let account = AccountController(
                serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/real-feed",
                credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
                rnServerImport: { .confirmed(ServerConfig.defaultServerURL) }
            )
            self.account = account
            let pairing = PairingService(link: link)
            let emoji = try await pairing.start(deviceName: "Feed check")
            script.note("paired emoji \(emoji.joined())")
            let credentials = try await pairing.confirm()
            let connection = try await account.agentConnections.add(credentials, name: link.name)
            let context = AppContext(account: account, variant: .development, version: "real-feed")
            guard let session = Session.session(for: connection.id, context: context) else { return script.fail("no session") }
            let navigation = UINavigationController(rootViewController: AgentHomeViewController(context: context, id: connection.id))
            AppCoordinator.applyAppearance(to: navigation.navigationBar)
            window.rootViewController = navigation
            if arguments.contains("-dark") { window.overrideUserInterfaceStyle = .dark }
            let feed = FeedViewController(session: session)
            navigation.pushViewController(feed, animated: false)
            await script.run(feed: feed)
        } catch {
            script.fail("\(error)")
        }
    }
}

@MainActor
private final class RealFeedScript {
    let window: UIWindow
    let names: (task: String, renamed: String, artifact: String, retitled: String)
    private var checks: [[String: Any]] = []
    private var notes: [String] = []
    private let folder: URL

    init(window: UIWindow, names: (task: String, renamed: String, artifact: String, retitled: String)) {
        self.window = window
        self.names = names
        folder = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("real-feed")
        try? FileManager.default.removeItem(at: folder)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    func note(_ text: String) {
        notes.append(text)
        print("REAL_FEED \(text)")
        write()
    }

    func fail(_ text: String) {
        check("ran", false, text)
        write()
    }

    private func check(_ name: String, _ passed: Bool, _ detail: String = "") {
        checks.append(["check": name, "passed": passed, "detail": detail])
        print("REAL_FEED \(passed ? "PASS" : "FAIL") \(name) \(detail)")
        write()
    }

    private func write() {
        let report: [String: Any] = ["checks": checks, "notes": notes, "passed": !checks.isEmpty && checks.allSatisfy { $0["passed"] as? Bool == true }]
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: folder.appendingPathComponent("report.json"))
        }
    }

    private func shoot(_ name: String) async {
        try? await Task.sleep(for: .milliseconds(700))
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        try? image.pngData()?.write(to: folder.appendingPathComponent("\(name).png"))
    }

    private func rows(_ list: CardListView) -> [CardItem] { list.items.filter { $0.kind == .row } }

    /// Polls until a row is titled `title`, and answers with the rows the
    /// apply that brought it redrew, against the poll just before it.
    private func follow(_ list: CardListView, to title: String, seconds: Double) async -> (found: CardItem?, redrawn: [String]) {
        let deadline = Date().addingTimeInterval(seconds)
        var before = Dictionary(uniqueKeysWithValues: rows(list).map { ($0.id, $0.revision) })
        while Date() < deadline {
            if let found = rows(list).first(where: { $0.accessibilityLabel == title }) {
                let redrawn = rows(list).filter { item in before[item.id].map { $0 != item.revision } ?? true }.map(\.accessibilityLabel)
                return (found, redrawn)
            }
            before = Dictionary(uniqueKeysWithValues: rows(list).map { ($0.id, $0.revision) })
            try? await Task.sleep(for: .milliseconds(50))
        }
        return (nil, [])
    }

    func run(feed: FeedViewController) async {
        let list = feed.activity
        let deadline = Date().addingTimeInterval(60)
        while Date() < deadline, !rows(list).contains(where: { $0.accessibilityLabel == names.task }) || !rows(list).contains(where: { $0.accessibilityLabel == names.artifact }) {
            try? await Task.sleep(for: .milliseconds(100))
        }
        let titles = rows(list).map(\.accessibilityLabel)
        check("the task's row is under its synced name", titles.contains(names.task), titles.joined(separator: " | "))
        check("the artifact's row is under its synced title", titles.contains(names.artifact))
        check("no row is a stand-in", !titles.contains { $0.isEmpty || $0 == "Untitled" })
        note("rows before: \(titles.joined(separator: " | "))")
        await shoot("1-before")
        note("ready for the rename")

        let renamed = await follow(list, to: names.renamed, seconds: 240)
        check("a task renamed on desktop: its row follows", renamed.found != nil, rows(list).map(\.accessibilityLabel).joined(separator: " | "))
        check("and that apply redrew only it", renamed.redrawn == [names.renamed], renamed.redrawn.joined(separator: " | "))
        await shoot("2-renamed")
        note("ready for the retitle")

        let retitled = await follow(list, to: names.retitled, seconds: 240)
        check("an artifact retitled on desktop: its row follows", retitled.found != nil, rows(list).map(\.accessibilityLabel).joined(separator: " | "))
        note("the retitle's apply redrew: \(retitled.redrawn.joined(separator: " | "))")
        await shoot("3-retitled")
        note("rows after: \(rows(list).map(\.accessibilityLabel).joined(separator: " | "))")
        note("DONE")
    }
}
#endif
