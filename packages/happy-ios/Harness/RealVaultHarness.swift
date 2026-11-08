#if canImport(UIKit) && (DEBUG || HAPPY_FIXTURES)
import Foundation
import QuickLook
@testable import HappyCore
@testable import HappyUI
import HappyWire
import UIKit

/// A vault Surface over a real Happy Agent daemon that serves vaults,
/// reached as a phone reaches one (`-screen realVault -pair
/// <happy://direct?…> -vault <surfaceId>`): it pairs through the mobile
/// connector as `RealFeedHarness` does, opens the vault from home and
/// walks it as a person would, through the screens' own taps (a row's
/// `onSelect`) and the library a picker or a prompt would call. Each step
/// is shot into `Documents/real-vault/` with `report.json` for
/// `devicectl`, and printed as `REAL_VAULT SHOT <name>` so a driver can
/// capture the device's own screen too (the share sheet and the pickers
/// draw out of process). The demo vault is left as it was found, but for
/// what the walk uploaded, which it moves to the Trash.
@MainActor
final class RealVaultHarness {
    private var account: AccountController?

    init(window: UIWindow, arguments: [String]) {
        Task { await open(window: window, arguments: arguments) }
    }

    private static func value(_ name: String, _ arguments: [String]) -> String? {
        arguments.firstIndex(of: name).flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil }
    }

    private func open(window: UIWindow, arguments: [String]) async {
        let script = RealVaultScript(window: window)
        do {
            guard let code = Self.value("-pair", arguments) else { return script.fail("no -pair code") }
            guard let vault = Self.value("-vault", arguments) else { return script.fail("no -vault") }
            let link = try PairingLink(code)
            let account = AccountController(
                serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/real-vault",
                credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
                rnServerImport: { .confirmed(ServerConfig.defaultServerURL) }
            )
            self.account = account
            let pairing = PairingService(link: link)
            let emoji = try await pairing.start(deviceName: "Vault check")
            script.note("paired emoji \(emoji.joined())")
            let credentials = try await pairing.confirm()
            let connection = try await account.agentConnections.add(credentials, name: link.name)
            let context = AppContext(account: account, variant: .development, version: "real-vault")
            guard let session = Session.session(for: connection.id, context: context) else { return script.fail("no session") }
            let navigation = UINavigationController(rootViewController: AgentHomeViewController(context: context, id: connection.id))
            AppCoordinator.applyAppearance(to: navigation.navigationBar)
            window.rootViewController = navigation
            if arguments.contains("-dark") { window.overrideUserInterfaceStyle = .dark }
            await script.run(session: session, navigation: navigation, surfaceId: vault, name: Self.value("-name", arguments) ?? "Demo vault",
                             searchOnly: arguments.contains("-searchOnly"),
                             queries: Self.value("-searchQueries", arguments).map { $0.split(separator: ",").map(String.init) } ?? [])
        } catch {
            script.fail("\(error)")
        }
    }
}

@MainActor
private final class RealVaultScript {
    let window: UIWindow
    private var checks: [[String: Any]] = []
    private var notes: [String] = []
    private let folder: URL
    private var navigation: UINavigationController!
    private var session: Session!
    private var surfaceId = ""
    private var name = ""
    private var library: VaultLibrary { session.engine.vaults }
    /// The actions behind the last menu, kept as a screen keeps its own.
    private var held: VaultActions?

    init(window: UIWindow) {
        self.window = window
        folder = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("real-vault")
        try? FileManager.default.removeItem(at: folder)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    func note(_ text: String) {
        notes.append(text)
        print("REAL_VAULT \(text)")
        write()
    }

    func fail(_ text: String) {
        check("ran", false, text)
        write()
    }

    @discardableResult
    private func check(_ name: String, _ passed: Bool, _ detail: String = "") -> Bool {
        checks.append(["check": name, "passed": passed, "detail": detail])
        print("REAL_VAULT \(passed ? "PASS" : "FAIL") \(name) \(detail)")
        write()
        return passed
    }

    private func write() {
        let report: [String: Any] = ["checks": checks, "notes": notes, "passed": !checks.isEmpty && checks.allSatisfy { $0["passed"] as? Bool == true }]
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: folder.appendingPathComponent("report.json"))
        }
    }

    private func sleep(_ seconds: Double) async { try? await Task.sleep(for: .milliseconds(Int(seconds * 1000))) }

    /// The window as drawn here, and a cue for the driver's device capture.
    private func shoot(_ name: String) async {
        await sleep(0.8)
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        try? image.pngData()?.write(to: folder.appendingPathComponent("\(name).png"))
        print("REAL_VAULT SHOT \(name)")
        await sleep(2.5)
    }

    /// The screen as it is this moment, with no pause first: the device's
    /// own capture would come too late.
    private func snap(_ name: String) {
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        try? image.pngData()?.write(to: folder.appendingPathComponent("\(name).png"))
        print("REAL_VAULT SNAP \(name)")
    }

    private func until(_ seconds: Double, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if condition() { return true }
            await sleep(0.1)
        }
        return condition()
    }

    // MARK: Screens

    private var top: UIViewController? { navigation.topViewController }
    private var browser: VaultViewController? { top as? VaultViewController }

    private func entry(_ name: String, in screen: VaultViewController? = nil) -> (id: String, entry: VaultEntry)? {
        for (id, row) in (screen ?? browser)?.rows ?? [:] {
            if case .entry(let entry) = row, entry.name == name { return (id, entry) }
        }
        return nil
    }

    /// The first row whose name starts so: other clients rename the demo's files while a walk runs.
    private func named(_ prefix: String, suffix: String = "", in screen: VaultViewController? = nil) -> String? {
        names(screen ?? browser).first { $0.hasPrefix(prefix) && $0.hasSuffix(suffix) }
    }

    /// Back at the vault's root with nothing presented, whatever a step left behind.
    private func reset(_ root: VaultViewController?) async {
        await dismissPresented()
        guard let root, navigation.viewControllers.contains(root), top !== root else { return }
        navigation.popToViewController(root, animated: false)
        await sleep(0.5)
    }

    private func names(_ screen: VaultViewController?) -> [String] {
        (screen?.list.items ?? []).filter { $0.kind == .row }.map(\.accessibilityLabel)
    }

    /// Taps the row named `name` on the browser on screen.
    @discardableResult
    private func tap(_ name: String) async -> Bool {
        guard await until(20, { entry(name) != nil }), let row = entry(name), let screen = browser else {
            return check("\(name) is on screen", false, names(browser).joined(separator: " | "))
        }
        screen.list.onSelect?(row.id)
        _ = await until(5) { top !== screen }
        await sleep(1)
        return true
    }

    private func back() async {
        navigation.popViewController(animated: true)
        await sleep(1)
    }

    private func dismissPresented() async {
        guard let presented = navigation.presentedViewController else { return }
        await withCheckedContinuation { continuation in presented.dismiss(animated: true) { continuation.resume() } }
        await sleep(0.5)
    }

    private func actions(_ host: UIViewController) -> VaultActions {
        let actions = VaultActions(session: session, surfaceId: surfaceId, vaultName: name, host: host)
        held = actions
        return actions
    }

    /// Folders before files, whatever else the vault holds today.
    private func foldersFirst(_ screen: VaultViewController?) -> Bool {
        let folders = names(screen).compactMap { entry($0, in: screen)?.entry.isFolder }
        return !folders.isEmpty && !zip(folders, folders.dropFirst()).contains { !$0 && $1 }
    }

    /// Moves to the Trash what an earlier walk or the live step left at the root.
    private func tidy(_ screen: VaultViewController?) async {
        let live = names(screen).filter { $0.hasPrefix("live from the computer") }
        for leftover in ["phone picture.png", "phone recording.bin"] + live {
            guard let found = entry(leftover, in: screen)?.entry else { continue }
            do {
                try await library.delete(surfaceId, found.id)
                note("moved \(leftover) to the Trash")
            } catch {
                note("could not tidy \(leftover): \(VaultActions.message(error))")
            }
        }
        _ = await until(10) { (["phone picture.png", "phone recording.bin"] + live).allSatisfy { entry($0, in: screen) == nil } }
    }

    private func temporary(_ name: String, _ data: Data) -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("real-vault-\(UUID().uuidString)").appendingPathComponent(name)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: url)
        return url
    }

    // MARK: The walk

    func run(session: Session, navigation: UINavigationController, surfaceId: String, name: String, searchOnly: Bool = false, queries: [String] = []) async {
        self.session = session
        self.navigation = navigation
        self.surfaceId = surfaceId
        self.name = name
        await sleep(6)
        await shoot("01-home")
        if !queries.isEmpty {
            await searchShots(queries)
            return note("DONE")
        }
        await homeSearch()
        if searchOnly { return note("DONE") }

        // The Surface list's row opens the vault's browser.
        navigation.pushViewController(SurfaceScreens.make(session: session, surface: AgentWire.Surface(id: surfaceId, type: "vault", name: name)), animated: true)
        let root = browser
        check("a vault Surface opens into its browser", root != nil)
        _ = await until(30) { ["Docs", "Empty folder", "Sites", "notes.txt"].allSatisfy { entry($0, in: root) != nil } }
        await tidy(root)
        check("the root lists its folders first", await until(10) { foldersFirst(root) }, names(root).joined(separator: " | "))
        await shoot("02-vault-root")
        await browse(root)
        await changes(root)
        await uploads(root)
        await history(root)
        await sharing(root)
        await settings(root)
        await live(root)
        await tidy(root)
        note("DONE")
    }

    /// Home's search, typed into the bar's field: the phone's own results
    /// at once, the computer's fused in (`POST /v0/search`), a file's
    /// matched words under its name, a found file opening in its vault,
    /// and a found message in its conversation.
    private func homeSearch() async {
        guard let agentHome = navigation.viewControllers.first as? AgentHomeViewController,
              let home = agentHome.children.compactMap({ $0 as? HomeViewController }).first else {
            check("home search", false, "no home")
            return
        }
        let rows = { home.resultsView.list.rows }
        let labels = { rows().map { $0.label + ($0.detail.map { " [\($0)]" } ?? "") }.joined(separator: " | ") }
        // Kinds only the computer finds: the phone holds none of them.
        let remote = { rows().contains { row in ["vault_file", "vault_folder", "message", "todo", "calendar_event"].contains { row.id.hasPrefix("found:\($0):") } } }
        let bar = agentHome.search
        // As a person types: the field takes the words, and UIKit tells search.
        func type(_ query: String) async {
            // The field opens, and its results fade in, before the typing.
            if !bar.isActive {
                bar.begin()
                await sleep(1.5)
            }
            bar.bar.searchTextField.text = ""
            bar.bar.searchTextField.insertText(query)
        }
        await type("plan")
        // Well inside the 120 ms pause before the computer is asked.
        await sleep(0.03)
        snap("00a-search-local")
        check("home search shows what the phone holds before the computer is asked",
              rows().contains { $0.label.lowercased().contains("plan") } && !remote(), labels())
        check("the field shows what was typed", bar.bar.searchTextField.text == "plan", bar.bar.searchTextField.text ?? "nil")
        check("a conversation the phone holds draws as a result, a chat bubble before it",
              rows().contains { $0.id.hasPrefix("found:agent:") && $0.kind == .result && $0.mark == .glyph("chatbubbles-outline") }, labels())
        check("and the computer's, fused in, with the words a file matched under its name",
              await until(15) { rows().contains { $0.id.hasPrefix("found:vault_file:") && $0.detail != nil } }, labels())
        await shoot("00b-search-fused")
        await type("launch")
        check("a vault app shows without .artifact", await until(15) { rows().contains { $0.id.hasPrefix("found:vault_file:") } } && !rows().contains { $0.label.hasSuffix(".artifact") }, labels())
        await type("revenue")
        check("a word only in a file's content finds it, with its line", await until(15) { rows().contains { $0.id.hasPrefix("found:vault_file:") && $0.detail?.lowercased().contains("revenue") == true } },
              labels())
        await shoot("00c-search-content")
        if let row = rows().first(where: { $0.id.hasPrefix("found:vault_file:") }) {
            home.resultsView.list.onSelect?(row)
            check("a found file opens in its vault", await until(15) { top is VaultPreviewViewController }, String(describing: top))
            await sleep(2)
            await shoot("00d-search-opened")
            navigation.popToRootViewController(animated: false)
            await sleep(0.5)
        }
        await type("launch")
        if await until(15, { rows().contains { $0.id.hasPrefix("found:message:") } }), let row = rows().first(where: { $0.id.hasPrefix("found:message:") }) {
            await shoot("00e-search-message")
            home.resultsView.list.onSelect?(row)
            check("a found message opens its conversation", await until(15) { top is ChatViewController }, String(describing: top))
            await sleep(2)
            await shoot("00f-search-message-opened")
            navigation.popToRootViewController(animated: false)
            await sleep(0.5)
        } else {
            note("no message says launch: \(labels())")
        }
        bar.end()
        await sleep(0.5)
    }

    /// Home's search for each of `queries`, typed into the bar's field: once
    /// the computer has answered, the results are listed and shot as
    /// `search-<query>`, then the first found row of each kind is opened.
    private func searchShots(_ queries: [String]) async {
        guard let agentHome = navigation.viewControllers.first as? AgentHomeViewController,
              let home = agentHome.children.compactMap({ $0 as? HomeViewController }).first else {
            check("home search", false, "no home")
            return
        }
        let rows = { home.resultsView.list.rows }
        let bar = agentHome.search
        let remote = { rows().contains { row in ["vault_file", "vault_folder", "message", "todo", "calendar_event", "document"].contains { row.id.hasPrefix("found:\($0):") } } }
        for query in queries {
            if !bar.isActive {
                bar.begin()
                await sleep(1.5)
            }
            bar.bar.searchTextField.text = ""
            bar.bar.searchTextField.insertText(query)
            check("\(query): the computer's results come in", await until(15) { remote() })
            await sleep(0.5)
            for row in rows() { note("\(query) ROW \(row.kind == .section ? "## " : "")\(row.label)\(row.detail.map { " — \($0)" } ?? "")  [\(row.id)]") }
            check("\(query): at most twelve found", rows().filter { $0.id.hasPrefix("found:") }.count <= HappyCore.Search.foundLimit)
            await shoot("search-\(query)")
        }
        for kind in ["vault_file", "message", "calendar_event"] {
            guard let query = queries.first else { break }
            bar.bar.searchTextField.text = ""
            bar.bar.searchTextField.insertText(kind == "vault_file" ? query : queries.last ?? query)
            guard await until(15, { rows().contains { $0.id.hasPrefix("found:\(kind):") } }), let row = rows().first(where: { $0.id.hasPrefix("found:\(kind):") }) else {
                note("no \(kind) found")
                continue
            }
            home.resultsView.list.onSelect?(row)
            check("a found \(kind) opens", await until(15) { navigation.viewControllers.count > 1 }, String(describing: top))
            await sleep(2)
            await shoot("search-opened-\(kind)")
            navigation.popToRootViewController(animated: false)
            await sleep(0.8)
        }
        bar.end()
        await sleep(0.5)
    }

    private func browse(_ root: VaultViewController?) async {
        await tap("Docs")
        check("Docs opens", browser?.title == "Docs")
        await shoot("03-folder-docs")
        await tap("Reports")
        check("the path shows under the folder's name", browser?.navigationItem.subtitle == "\(name) › Docs", browser?.navigationItem.subtitle ?? "")
        await shoot("04-folder-reports-path")
        await tap("Q3 summary.txt")
        check("text previews as lines", await until(15) { (top?.view.subviews.contains { $0 is FileLinesView }) == true })
        await shoot("05-preview-text")
        await back()
        if await tap("budget.csv") {
            await sleep(2)
            await shoot("06-preview-csv")
        }
        await reset(root)
        await tap("Docs")
        _ = await until(10) { named("Launch plan", suffix: ".md") != nil }
        if let plan = named("Launch plan", suffix: ".md"), await tap(plan) {
            await sleep(4)
            await shoot("07-preview-markdown")
            await back()
        }
        if let pdf = named("", suffix: ".pdf"), await tap(pdf) {
            check("a PDF previews in Quick Look", await until(30) { top?.children.contains { $0 is QLPreviewController } == true })
            await sleep(3)
            await shoot("07b-preview-pdf")
        }
        await reset(root)
        await tap("Empty folder")
        await shoot("08-empty-folder")
        await reset(root)
        await tap("Sites")
        check("apps show by their names, without .artifact", await until(15) {
            entry("launch.artifact") != nil && entry("handbook.artifact") != nil && names(browser).contains("launch") && !names(browser).contains { $0.hasSuffix(".artifact") }
        }, names(browser).joined(separator: " | "))
        await shoot("09-folder-sites")
        await tap("launch.artifact")
        check("an app's preview is titled without .artifact", top?.title == "launch", top?.title ?? "")
        await sleep(8)
        await shoot("10-preview-app-live")
        await back()
        await tap("handbook.artifact")
        await sleep(6)
        await shoot("11-preview-markdown-app")
        await reset(root)
        root?.setSort(VaultSort(key: .updatedAt))
        await sleep(1)
        check("folders stay first in another order", foldersFirst(root), names(root).joined(separator: " | "))
        await shoot("12-sorted-by-date")
        root?.setSort(.name)
    }

    private func changes(_ root: VaultViewController?) async {
        guard let root else { return }
        await reset(root)
        // The prompt a person types the name into.
        actions(root).newFolder(in: nil)
        await sleep(1)
        await shoot("15-new-folder-prompt")
        await dismissPresented()
        do {
            try await library.createFolder(surfaceId, parentId: nil, name: "Phone test")
            check("a new folder shows", await until(10) { entry("Phone test", in: root) != nil })
            await shoot("16-new-folder")
            guard let made = entry("Phone test", in: root)?.entry else { return }
            try await library.rename(surfaceId, made.id, to: "Phone folder")
            check("a rename shows", await until(10) { entry("Phone folder", in: root) != nil })
            guard let notes = entry("notes.txt", in: root)?.entry else { return fail("no notes.txt") }
            actions(root).move(notes)
            await sleep(2)
            await shoot("17-move-picker")
            await dismissPresented()
            try await library.move(surfaceId, notes.id, to: .folder(made.id))
            check("a moved file leaves the folder", await until(10) { entry("notes.txt", in: root) == nil })
            await tap("Phone folder")
            check("and lands in the other", await until(10) { entry("notes.txt") != nil })
            await shoot("18-moved-into-folder")
            await reset(root)
            try await library.delete(surfaceId, made.id)
            check("a folder in the Trash leaves the list", await until(10) { entry("Phone folder", in: root) == nil })
            navigation.pushViewController(VaultTrashViewController(session: session, surfaceId: surfaceId, vaultName: name), animated: true)
            let trash = top as? VaultTrashViewController
            check("the Trash lists it", await until(15) { trash?.items.values.contains { $0.entry.id == made.id } == true })
            await shoot("19-trash")
            if let item = trash?.items.values.first(where: { $0.entry.id == made.id }) {
                try await library.restore(surfaceId, item)
                check("restoring takes it out of the Trash", await until(10) { trash?.items.values.contains { $0.entry.id == made.id } == false })
                await shoot("20-trash-after-restore")
            }
            await reset(root)
            check("and brings it back where it was", await until(10) { entry("Phone folder", in: root) != nil })
            await shoot("21-restored")
            // As it was: notes.txt at the root, the folder in the Trash.
            try await library.move(surfaceId, notes.id, to: .root)
            try await library.delete(surfaceId, made.id)
        } catch {
            check("folder changes", false, VaultActions.message(error))
        }
    }

    private func uploads(_ root: VaultViewController?) async {
        guard let root else { return }
        await reset(root)
        actions(root).choosePhotos(into: nil)
        await sleep(3)
        await shoot("22-photos-picker")
        await dismissPresented()
        actions(root).chooseFiles(into: nil)
        await sleep(3)
        await shoot("23-files-picker")
        await dismissPresented()
        // What the pickers hand the library: a picture, then a large file to watch go.
        let picture = UIGraphicsImageRenderer(size: CGSize(width: 600, height: 400)).image { context in
            UIColor.systemTeal.setFill(); context.fill(CGRect(x: 0, y: 0, width: 600, height: 400))
            UIColor.white.setFill(); context.fill(CGRect(x: 200, y: 100, width: 200, height: 200))
        }.pngData() ?? Data()
        await library.upload(surfaceId, parentId: nil, file: temporary("phone picture.png", picture), name: "phone picture.png")
        var big = Data(count: 24 * 1024 * 1024)
        big.withUnsafeMutableBytes { bytes in for i in stride(from: 0, to: bytes.count, by: 4096) { bytes[i] = UInt8(truncatingIfNeeded: i >> 12) } }
        await library.upload(surfaceId, parentId: nil, file: temporary("phone recording.bin", big), name: "phone recording.bin")
        check("an upload shows its progress", await until(10) { root.state.uploads.contains { $0.name == "phone recording.bin" } })
        await sleep(1)
        await shoot("24-upload-progress")
        check("uploads land as files", await until(240) { entry("phone picture.png", in: root) != nil && entry("phone recording.bin", in: root) != nil },
              root.state.uploads.map { "\($0.name) \($0.phase)" }.joined(separator: " | "))
        await shoot("25-uploaded")
        await tap("phone picture.png")
        await sleep(3)
        await shoot("26-preview-image")
        await reset(root)
        // A second upload of the same name is a new version.
        if let picture = entry("phone picture.png", in: root)?.entry {
            await library.upload(surfaceId, parentId: nil, file: temporary("phone picture.png", Data(picture.name.utf8) + Data(count: 10)), name: picture.name, replacing: picture.id)
            check("uploading over a file makes version 2", await until(60) { entry("phone picture.png", in: root)?.entry.latestVersion == 2 })
        }
        // An .artifact downloaded and uploaded back is the same app.
        await tap("Sites")
        if let site = entry("launch.artifact")?.entry, let sites = browser {
            let target = FileManager.default.temporaryDirectory.appendingPathComponent("real-vault-\(UUID().uuidString)/launch copy.artifact")
            do {
                try await session.client.download(AgentClient.vaultArtifactZipPath(surfaceId, site.id, version: site.latestVersion ?? 1), to: target)
                check("an artifact downloads as a .artifact file", (try? Data(contentsOf: target).prefix(2)) == Data("PK".utf8))
                await library.upload(surfaceId, parentId: site.parentId, file: target, name: "launch copy.artifact", kind: .artifact)
                check("and uploads back as an app", await until(60) { entry("launch copy.artifact", in: sites)?.entry.kind == .artifact })
            } catch {
                check("an artifact round trip", false, VaultActions.message(error))
            }
            // A file named .artifact that isn't one says why.
            await library.upload(surfaceId, parentId: site.parentId, file: temporary("broken.artifact", Data("not a zip".utf8)), name: "broken.artifact", kind: .artifact)
            let refused = await until(30) { sites.state.uploads.contains { if case .failed = $0.phase { true } else { false } } }
            check("a bad .artifact shows the computer's reason", refused, sites.state.uploads.map { "\($0.name) \($0.phase)" }.joined(separator: " | "))
            await shoot("27-app-uploads")
            for upload in sites.state.uploads { await library.cancelUpload(surfaceId, upload.id) }
            if let copy = entry("launch copy.artifact", in: sites)?.entry { await app(copy, in: sites) }
        }
        await reset(root)
    }

    /// An app is named, shared and trashed without its `.artifact`, which it keeps.
    private func app(_ copy: VaultEntry, in sites: VaultViewController) async {
        actions(sites).rename(copy)
        await sleep(1)
        let typed = (navigation.presentedViewController as? UIAlertController)?.textFields?.first?.text
        check("renaming an app edits its name without .artifact", typed == "launch copy", typed ?? "no prompt")
        await shoot("27a-rename-app-prompt")
        await dismissPresented()
        do {
            try await library.rename(surfaceId, copy.id, to: VaultEntry.appName("launch again"))
        } catch {
            check("an app's rename", false, VaultActions.message(error))
        }
        check("and the app keeps .artifact", await until(10) { entry("launch again.artifact", in: sites)?.entry.kind == .artifact && names(sites).contains("launch again") },
              names(sites).joined(separator: " | "))
        guard let renamed = entry("launch again.artifact", in: sites)?.entry else { return }
        actions(sites).share(renamed, view: sites.view)
        check("an app shares as its .artifact file", await until(30) { navigation.presentedViewController is UIActivityViewController })
        await shoot("27b-share-app")
        await dismissPresented()
        try? await library.delete(surfaceId, renamed.id)
        navigation.pushViewController(VaultTrashViewController(session: session, surfaceId: surfaceId, vaultName: name), animated: true)
        let trash = top as? VaultTrashViewController
        let labels = { (trash?.list.items ?? []).filter { $0.kind == .row }.map(\.accessibilityLabel) }
        check("the Trash shows the app without .artifact", await until(15) { labels().contains("launch again") && !labels().contains { $0.hasSuffix(".artifact") } },
              labels().joined(separator: " | "))
        await shoot("27c-trash-app")
        await back()
    }

    private func history(_ root: VaultViewController?) async {
        await reset(root)
        await tap("Docs")
        _ = await until(10) { named("Launch plan", suffix: ".md") != nil }
        guard let planName = named("Launch plan", suffix: ".md"), let plan = entry(planName)?.entry else {
            check("the history lists the versions", false, "no Launch plan in Docs: " + names(browser).joined(separator: " | "))
            return
        }
        navigation.pushViewController(VaultHistoryViewController(session: session, surfaceId: surfaceId, vaultName: name, entry: plan), animated: true)
        let history = top as? VaultHistoryViewController
        check("the history lists the versions", await until(15) { (history?.versions.count ?? 0) >= 3 }, "\(history?.versions.count ?? 0)")
        await shoot("28-history")
        do {
            _ = try await library.pin(surfaceId, plan.id, number: 1, pinned: true)
            check("a pin shows", await until(10) { history?.versions["v:1"]?.pinned == true })
            await shoot("29-history-pinned")
            navigation.pushViewController(VaultPreviewViewController(session: session, surfaceId: surfaceId, vaultName: name, entry: plan, version: 2), animated: true)
            await sleep(4)
            await shoot("30-preview-version-2")
            await back()
            // An earlier version whose content differs: restoring the current content makes no version.
            let before = plan.latestVersion ?? 0
            let current = history?.versions.values.first { $0.number == before }
            let older = history?.versions.values.filter { $0.number < before && ($0.sha256 == nil || $0.sha256 != current?.sha256) }.max { $0.number < $1.number }
            guard let older else {
                check("restoring a version makes a new one", false, "no earlier version that differs")
                return
            }
            _ = try await library.restoreVersion(surfaceId, plan.id, number: older.number)
            check("restoring a version makes a new one", await until(15) { history?.versions["v:\(before + 1)"]?.restoredFrom == older.number }, "from \(older.number)")
            await shoot("31-history-restored")
            _ = try await library.pin(surfaceId, plan.id, number: 1, pinned: false)
        } catch {
            check("history", false, VaultActions.message(error))
        }
        await reset(root)
    }

    private func sharing(_ root: VaultViewController?) async {
        await reset(root)
        guard let root, let sites = entry("Sites", in: root)?.entry, let notes = entry("notes.txt", in: root)?.entry else {
            check("a file opens in the share sheet", false, "no Sites or notes.txt: " + names(root).joined(separator: " | "))
            return
        }
        actions(root).share(notes, view: root.view)
        check("a file opens in the share sheet", await until(30) { navigation.presentedViewController is UIActivityViewController })
        await shoot("32-share-file")
        await dismissPresented()
        actions(root).share(sites, view: root.view)
        check("a folder shares as a zip", await until(60) { navigation.presentedViewController is UIActivityViewController })
        await shoot("33-share-folder-zip")
        await dismissPresented()
    }

    private func settings(_ root: VaultViewController?) async {
        await reset(root)
        navigation.pushViewController(VaultSettingsViewController(session: session, surfaceId: surfaceId), animated: true)
        guard let screen = top as? VaultSettingsViewController else { return }
        check("the settings read", await until(15) { screen.settings != nil })
        if let left = screen.settings?.retention, left != .standard {
            // An earlier walk that stopped short left its rules; the default first.
            note("the vault had \(left); setting Time Machine, 30 days")
            screen.list.onSelect?("p:timeMachine")
            _ = await until(10) { screen.settings?.retention.preset == .timeMachine }
            screen.list.onSelect?("t:30")
            _ = await until(10) { screen.settings?.retention == .standard }
            await sleep(1)
        }
        let before = screen.settings?.retention
        check("a new vault is Time Machine, 30 days in the Trash", before?.preset == .timeMachine && before?.trashDays == 30, "\(String(describing: before))")
        await shoot("34-settings-default")
        screen.list.onSelect?("p:lastTen")
        check("Last 10 versions is saved", await until(10) { screen.settings?.retention.maxVersions == 10 })
        await shoot("35-settings-last-ten")
        screen.list.onSelect?("p:custom")
        await sleep(1)
        await shoot("36-settings-custom")
        screen.list.onSelect?("t:7")
        check("the Trash time keeps the rules", await until(10) { screen.settings?.retention.trashDays == 7 && screen.settings?.retention.maxVersions == 10 })
        screen.list.scroll(to: "t:7", animated: false)
        await shoot("37-settings-trash-week")
        // One tap at a time, each landing before the next, as a finger would.
        screen.list.onSelect?("p:timeMachine")
        _ = await until(10) { screen.settings?.retention.preset == .timeMachine }
        screen.list.onSelect?("t:30")
        check("and back to the default", await until(10) { screen.settings?.retention == .standard })
        screen.list.scrollToTop(animated: false)
        await shoot("38-settings-back")
        await back()
    }

    /// Something made on the computer shows with no refresh.
    private func live(_ root: VaultViewController?) async {
        guard let root else { return }
        await reset(root)
        note("ready for the live folder")
        let shown = await until(300) { names(root).contains { $0.hasPrefix("live from the computer") } }
        check("a folder made on the computer shows here", shown, names(root).joined(separator: " | "))
        await shoot("39-live-update")
    }
}
#endif
