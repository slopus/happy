import AppKit
import HappyCore

@main
enum HappyMacMain {
    @MainActor static func main() {
        let application = NSApplication.shared
        let delegate = MacAppDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { application.run() }
    }
}

@MainActor
final class MacAppDelegate: NSObject, NSApplicationDelegate {
    private(set) var controller: MacWindowController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let bundle = Bundle.main
        let namespace = bundle.bundleIdentifier ?? "com.slopus.happy.native.mac"
        let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
        let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("Happy", isDirectory: true)
        let account = NativeAccountFactory.make(
            version: version, directory: directory,
            backend: NamespacedKeychainBackend(base: SecurityKeychainBackend(), namespace: namespace),
            defaultsNamespace: namespace,
            // A Mac install never imports iPhone MMKV or guesses the server
            // for a recovered key after registry corruption.
            importLegacyServer: { .needsConfirmation },
            appState: { await MainActor.run { NSApp.isActive ? "active" : "background" } }
        )
        // Direct/Stem Cells is a separate UI port; don't offer half a flow.
        account.showsComputers = false
        controller = MacWindowController(account: account)
        installMenus()
        controller?.showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)
        controller?.start()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        controller?.showWindow(nil)
        return true
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        controller?.showWindow(nil)
        for url in urls { controller?.openPairingURL(url.absoluteString) }
    }

    func applicationDidBecomeActive(_ notification: Notification) { presence("active") }
    func applicationDidResignActive(_ notification: Notification) { presence("background") }
    private func presence(_ value: String) {
        guard let session = controller?.account.session else { return }
        Task { await session.sendPresence(value) }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let session = controller?.account.session else { return .terminateNow }
        Task {
            await session.stop()
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    private func installMenus() {
        let main = NSMenu()
        func menu(_ title: String) -> NSMenu {
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            let submenu = NSMenu(title: title)
            item.submenu = submenu; main.addItem(item)
            return submenu
        }
        let app = menu("Happy")
        app.addItem(withTitle: "About Happy", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        let settings = app.addItem(withTitle: "Settings…", action: #selector(MacWindowController.showSettings(_:)), keyEquivalent: ",")
        settings.target = controller
        let services = NSMenu(title: "Services")
        let servicesItem = NSMenuItem(title: "Services", action: nil, keyEquivalent: "")
        servicesItem.submenu = services; app.addItem(servicesItem); NSApp.servicesMenu = services
        app.addItem(.separator())
        app.addItem(withTitle: "Hide Happy", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(withTitle: "Quit Happy", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let file = menu("File")
        let new = file.addItem(withTitle: "New Session…", action: #selector(MacWindowController.newSession(_:)), keyEquivalent: "n")
        new.target = controller
        let pair = file.addItem(withTitle: "Connect a Computer…", action: #selector(MacWindowController.pairComputer(_:)), keyEquivalent: "")
        pair.target = controller
        file.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        let edit = menu("Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        let window = menu("Window")
        window.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        window.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        NSApp.windowsMenu = window
        NSApp.mainMenu = main
    }
}