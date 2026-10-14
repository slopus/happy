#if canImport(UIKit)
import HappyCore
@testable import HappyUI
import UIKit
import XCTest

/// The secondary screens' and the tablet's words in the language the
/// screens speak, their English as happy-app's _default.ts has it, and the
/// words happy-app writes in English, still English.
@MainActor
final class SecondaryStringsTests: XCTestCase {
    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    override func tearDown() {
        AppLocalization.use(nil)
        super.tearDown()
    }

    func testEnglishIsHappyAppsOwn() async {
        AppLocalization.use(nil)
        // Decoded off the main thread, as the app decodes every catalog:
        // decoding on it stops Debug builds.
        let english = await TranslationCatalog.load("en")
        typealias S = Strings.SessionDetail
        // _default.ts's, which index.ts serves, not translations/en.ts's.
        XCTAssertEqual(Strings.MachineDetail.deleteFooter, "Remove this machine from your account. Session history will be preserved, but you will not be able to start new sessions on this machine.")
        XCTAssertEqual(Strings.MachineDetail.deleteConfirmMessage, "The machine will be removed from your account. Session history will be preserved, but you will not be able to start new sessions until you reconnect the daemon.")
        XCTAssertEqual(S.minutesAgo(1), "1 minute ago")
        XCTAssertEqual(S.hoursAgo(2), "2 hours ago")
        XCTAssertEqual(S.daysAgo(1), "1 day ago")
        XCTAssertEqual(Strings.FilesDetail.changedFiles(1), "1 changed file")
        XCTAssertEqual(Strings.FilesDetail.changedFiles(3), "3 changed files")
        XCTAssertEqual(Strings.FilesDetail.loadingFile("a.swift"), "Loading a.swift...")
        XCTAssertEqual(Strings.DiffDetail.showMoreLines(1), "Show 1 more lines")
        // A function's English is not a literal the strings check can read:
        // each is compared with the English catalog here.
        for count in [0, 1, 2, 11, 59] {
            XCTAssertEqual(S.minutesAgo(count), english("time.minutesAgo", ["count": .number(count)]))
            XCTAssertEqual(S.hoursAgo(count), english("time.hoursAgo", ["count": .number(count)]))
            XCTAssertEqual(S.daysAgo(count), english("time.daysAgo", ["count": .number(count)]))
            XCTAssertEqual(Strings.FilesDetail.changedFiles(count), english("files.changedFiles", ["count": .number(count)]))
            XCTAssertEqual(Strings.DiffDetail.showMoreLines(count), english("diff.showMoreLines", ["count": .number(count)]))
        }
        XCTAssertEqual(Strings.FilesDetail.loadingFile("a.swift"), english("files.loadingFile", ["fileName": "a.swift"]))
        // info.tsx 488: the translated "Copy session metadata", then English.
        XCTAssertEqual(S.copyMetadataAndLogs, "Copy session metadata\n& Client Logs")
    }

    func testAnotherLanguageReadsItsCatalog() async {
        let russian = await TranslationCatalog.load("ru")
        AppLocalization.use(russian)
        typealias S = Strings.SessionDetail
        XCTAssertEqual(S.quickActions, russian("sessionInfo.quickActions"))
        XCTAssertEqual(S.sessionDeleted, russian("errors.sessionDeleted"))
        XCTAssertEqual(S.justNow, russian("time.justNow"))
        XCTAssertEqual(S.copyMetadataAndLogs, russian("sessionInfo.copyMetadata") + "\n& Client Logs")
        XCTAssertEqual(Strings.MachineDetail.deleteFooter, russian("machine.deleteFooter"))
        XCTAssertEqual(Strings.MachineDetail.sessions, russian("tabs.sessions"))
        XCTAssertEqual(Strings.MachineDetail.rename, russian("common.rename"))
        XCTAssertEqual(Strings.FilesDetail.retry, russian("common.retry"))
        XCTAssertEqual(Strings.FileViewerDetail.title, russian("common.fileViewer"))
        XCTAssertEqual(Strings.ChangesDetail.title, russian("sessionInfo.viewChanges"))
        XCTAssertEqual(Strings.Tablet.newSession, russian("sidebar.newSession"))
        XCTAssertEqual(Strings.Tablet.zenToggle, russian("zen.toggle"))
        XCTAssertEqual(Strings.Tablet.unknown, russian("status.unknown"))
        XCTAssertEqual(Strings.MachineDetail.unknown, russian("status.unknown"))
        for count in [1, 3, 5, 21] {
            XCTAssertEqual(S.minutesAgo(count), russian("time.minutesAgo", ["count": .number(count)]))
            XCTAssertEqual(S.hoursAgo(count), russian("time.hoursAgo", ["count": .number(count)]))
            XCTAssertEqual(S.daysAgo(count), russian("time.daysAgo", ["count": .number(count)]))
            XCTAssertEqual(Strings.FilesDetail.changedFiles(count), russian("files.changedFiles", ["count": .number(count)]))
            XCTAssertEqual(Strings.DiffDetail.showMoreLines(count), russian("diff.showMoreLines", ["count": .number(count)]))
        }
        XCTAssertEqual(Strings.FilesDetail.loadingFile("a.swift"), russian("files.loadingFile", ["fileName": "a.swift"]))
        XCTAssertNotEqual(Strings.Tablet.newSession, "New session")
        XCTAssertNotEqual(Strings.MachineDetail.stopDaemon, "Stop Daemon")
        // machine/[id].tsx writes its stop and rename alerts in English (56,
        // 60, 144), SessionsList.tsx its "Bots" (451).
        XCTAssertEqual(Strings.MachineDetail.stopDaemonCancel, "Cancel")
        XCTAssertEqual(Strings.MachineDetail.stopDaemonConfirm, "Stop Daemon")
        XCTAssertEqual(Strings.MachineDetail.renameErrorTitle, "Error")
        XCTAssertEqual(Strings.Tablet.bots, "Bots")
    }

    func testTheSidebarBuiltInAnotherLanguageSpeaksIt() async {
        let russian = await TranslationCatalog.load("ru")
        AppLocalization.use(russian)
        let button = SidebarNewSessionButton()
        XCTAssertEqual(button.label.string, russian("sidebar.newSession"))
        XCTAssertEqual(button.accessibilityLabel, russian("sidebar.newSession"))
        XCTAssertEqual(TabletPersistentHeaderView().zenButton.accessibilityLabel, russian("zen.toggle"))
    }
}
#endif
