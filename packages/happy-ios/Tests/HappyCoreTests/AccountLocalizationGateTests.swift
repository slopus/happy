import Foundation
import XCTest
@testable import HappyCore
import HappyStore
import HappyWire

private enum LocalizationFailure: Error { case failed }

/// Deliberately ignores cancellation so tests exercise obsolete completion.
private actor HeldLocale {
    private var waiter: CheckedContinuation<String, any Error>?
    private var entered = false
    private var enteredWaiters: [CheckedContinuation<Void, Never>] = []

    func read() async throws -> String {
        try await withCheckedThrowingContinuation { waiter in
            self.waiter = waiter
            entered = true
            for continuation in enteredWaiters { continuation.resume() }
            enteredWaiters.removeAll()
        }
    }

    func waitUntilEntered() async {
        if entered { return }
        await withCheckedContinuation { enteredWaiters.append($0) }
    }

    func release(_ result: Result<String, any Error>) {
        waiter?.resume(with: result)
        waiter = nil
    }
}

private actor LocaleLoadCounts {
    private var codes: [String] = []
    func record(_ code: String) { codes.append(code) }
    func snapshot() -> [String] { codes }
}

@MainActor
final class AccountLocalizationGateTests: XCTestCase {
    private typealias Gate = AccountLocalizationGate<String>

    func testSameLanguageResolvesOffMainWithoutLoadingAndAppliesBeforeRelease() async {
        let gate = Gate()
        let counts = LocaleLoadCounts()
        var events: [String] = []
        gate.onPendingChange = { events.append($0 ? "hold" : "release") }
        gate.update(currentLanguage: "ja", resolve: {
            dispatchPrecondition(condition: .notOnQueue(.main))
            return "ja"
        }, load: { code in
            await counts.record(code)
            return code
        }, apply: { result in
            XCTAssertTrue(gate.isPending)
            guard case .success(.unchanged) = result else { return XCTFail("unchanged language") }
            events.append("install account root")
        })
        XCTAssertTrue(gate.isPending)
        XCTAssertEqual(events, ["hold"])
        await gate.waitForIdle()
        let loaded = await counts.snapshot()
        XCTAssertEqual(loaded, [])
        XCTAssertEqual(events, ["hold", "install account root", "release"])
    }

    func testChangedLanguageDecodesOffMainAndEnglishNeverLoads() async {
        let gate = Gate()
        let counts = LocaleLoadCounts()
        var catalogs: [String?] = []
        let apply: @MainActor (Result<Gate.Decision, any Error>) -> Void = { result in
            guard case .success(.replace(let catalog)) = result else { return XCTFail("replacement") }
            catalogs.append(catalog)
        }
        gate.update(currentLanguage: "en", resolve: { "ja" }, load: { code in
            dispatchPrecondition(condition: .notOnQueue(.main))
            await counts.record(code)
            return code
        }, apply: apply)
        await gate.waitForIdle()
        gate.update(currentLanguage: "ja", resolve: { "en" }, load: { code in
            await counts.record(code)
            return code
        }, apply: apply)
        await gate.waitForIdle()
        let loaded = await counts.snapshot()
        XCTAssertEqual(loaded, ["ja"])
        XCTAssertEqual(catalogs, ["ja", nil])
        XCTAssertFalse(gate.isPending)
    }

    func testResolveAndLoadFailuresApplyFallbackBeforeReenabling() async {
        for failAtLoad in [false, true] {
            let gate = Gate()
            var events: [String] = []
            gate.onPendingChange = { events.append($0 ? "hold" : "release") }
            gate.update(currentLanguage: "en", resolve: {
                if !failAtLoad { throw LocalizationFailure.failed }
                return "ja"
            }, load: { _ in throw LocalizationFailure.failed }, apply: { result in
                guard case .failure = result else { return XCTFail("failure") }
                XCTAssertTrue(gate.isPending)
                events.append("install fallback root")
            })
            await gate.waitForIdle()
            XCTAssertEqual(events, ["hold", "install fallback root", "release"])
            XCTAssertFalse(gate.isPending)
        }
    }

    func testCancelPropagatesToHeldWorkerAndDropsItsLateResult() async {
        let gate = Gate()
        let held = HeldLocale()
        let cancelled = expectation(description: "detached worker cancelled")
        var events: [String] = []
        gate.onPendingChange = { events.append($0 ? "hold" : "release") }
        gate.update(currentLanguage: "en", resolve: {
            try await withTaskCancellationHandler {
                try await held.read()
            } onCancel: { cancelled.fulfill() }
        }, load: { _ in XCTFail("cancelled resolution must not load"); return "ja" }, apply: { result in
            guard case .failure(let error) = result, error is CancellationError else {
                return XCTFail("cancellation fallback")
            }
            XCTAssertTrue(gate.isPending)
            events.append("install fallback root")
        })
        await held.waitUntilEntered()
        let obsolete = gate.pendingWork
        gate.cancel()
        gate.cancel()
        XCTAssertFalse(gate.isPending)
        XCTAssertEqual(events, ["hold", "install fallback root", "release"])
        await fulfillment(of: [cancelled], timeout: 2)
        await held.release(.success("ja"))
        await obsolete?.value
        XCTAssertEqual(events, ["hold", "install fallback root", "release"])
    }

    func testReentrantApplyCannotReleaseNewerRequest() async {
        let gate = Gate()
        let newer = HeldLocale()
        var events: [String] = []
        gate.onPendingChange = { events.append($0 ? "hold" : "release") }
        gate.update(currentLanguage: "en", resolve: { "en" }, load: { _ in nil }, apply: { _ in
            events.append("old apply")
            gate.update(currentLanguage: "en", resolve: { try await newer.read() }, load: { $0 }, apply: { _ in
                XCTAssertTrue(gate.isPending)
                events.append("new apply")
            })
        })
        await newer.waitUntilEntered()
        XCTAssertTrue(gate.isPending)
        XCTAssertEqual(events, ["hold", "old apply"])
        await newer.release(.success("ja"))
        await gate.waitForIdle()
        XCTAssertEqual(events, ["hold", "old apply", "new apply", "release"])
    }

    func testSupersededLoadReceivesCancellationAndItsFailureCannotReleaseLatestHold() async {
        let gate = Gate()
        let older = HeldLocale(), newer = HeldLocale()
        let cancelled = expectation(description: "superseded decoder cancelled")
        var events: [String] = []
        gate.onPendingChange = { events.append($0 ? "hold" : "release") }
        gate.update(currentLanguage: "en", resolve: { "ja" }, load: { _ in
            try await withTaskCancellationHandler {
                try await older.read()
            } onCancel: { cancelled.fulfill() }
        }, apply: { _ in XCTFail("obsolete failure must not install fallback") })
        await older.waitUntilEntered()
        let obsolete = gate.pendingWork
        gate.update(currentLanguage: "en", resolve: { "ru" }, load: { _ in try await newer.read() }, apply: { result in
            guard case .success(.replace("ru")) = result else { return XCTFail("newest catalog") }
            XCTAssertTrue(gate.isPending)
            events.append("new apply")
        })
        await newer.waitUntilEntered()
        await fulfillment(of: [cancelled], timeout: 2)
        await older.release(.failure(LocalizationFailure.failed))
        await obsolete?.value
        XCTAssertTrue(gate.isPending)
        XCTAssertEqual(events, ["hold"])
        await newer.release(.success("ru"))
        await gate.waitForIdle()
        XCTAssertEqual(events, ["hold", "new apply", "release"])
    }

    func testReentrantCancellationFallbackCannotReleaseNewerRequest() async {
        let gate = Gate()
        let old = HeldLocale(), newer = HeldLocale()
        var events: [String] = []
        gate.onPendingChange = { events.append($0 ? "hold" : "release") }
        gate.update(currentLanguage: "en", resolve: { try await old.read() }, load: { $0 }, apply: { _ in
            events.append("cancel fallback")
            gate.update(currentLanguage: "en", resolve: { try await newer.read() }, load: { $0 }, apply: { _ in
                events.append("new apply")
            })
        })
        await old.waitUntilEntered()
        let obsolete = gate.pendingWork
        gate.cancel()
        await newer.waitUntilEntered()
        await old.release(.success("ja"))
        await obsolete?.value
        XCTAssertTrue(gate.isPending)
        XCTAssertEqual(events, ["hold", "cancel fallback"])
        await newer.release(.success("ja"))
        await gate.waitForIdle()
        XCTAssertEqual(events, ["hold", "cancel fallback", "new apply", "release"])
    }

    func testInteractionCallbackMaySupersedeRequestBeforeItStarts() async {
        let gate = Gate()
        var applied = 0
        gate.onPendingChange = { pending in
            if pending {
                gate.update(currentLanguage: "en", resolve: { "en" }, load: { _ in nil }, apply: { _ in applied += 1 })
            }
        }
        gate.update(currentLanguage: "en", resolve: { XCTFail("superseded before start"); return "ja" },
                    load: { _ in nil }, apply: { _ in XCTFail("obsolete apply") })
        await gate.waitForIdle()
        XCTAssertEqual(applied, 1)
        XCTAssertFalse(gate.isPending)
    }

    func testTwoRealAccountsJapaneseEnglishJapaneseDropLateLoadWithoutReenablingNewHold() async throws {
        let account = AccountController(serverConfig: ServerConfig(storage: InMemoryKeyValueStore()),
            clientID: "ios/test", credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) }, transport: FakeHTTP(), connector: FakeConnector())
        let japanese = Credentials(token: "japanese", secret: Data(repeating: 21, count: 32))
        let english = Credentials(token: "english", secret: Data(repeating: 22, count: 32))
        try await account.signIn(japanese)
        let japaneseSession = try XCTUnwrap(account.session)
        try await Task.detached { try japaneseSession.store.addPendingSettings(["preferredLanguage": .string("ja")]) }.value
        let gate = Gate()
        let firstLoad = HeldLocale(), lastLoad = HeldLocale()
        let counts = LocaleLoadCounts()
        var language = "en"
        var roots: [String] = []
        var holds: [Bool] = []
        gate.onPendingChange = { holds.append($0) }
        func request(_ session: AccountSession, held: HeldLocale) {
            gate.update(currentLanguage: language, resolve: {
                dispatchPrecondition(condition: .notOnQueue(.main))
                return try AccountSettings(session.store.settingsSnapshot()).preferredLanguage ?? "en"
            }, load: { code in
                dispatchPrecondition(condition: .notOnQueue(.main))
                await counts.record(code)
                return try await held.read()
            }, apply: { result in
                XCTAssertTrue(gate.isPending)
                XCTAssertTrue(account.session === session)
                if case .success(.replace(let catalog)) = result { language = catalog ?? "en" }
                else if case .failure = result { XCTFail("winning resolution failed") }
                roots.append(session.keys.anonID)
            })
        }
        request(japaneseSession, held: firstLoad)
        await firstLoad.waitUntilEntered()
        let obsolete = gate.pendingWork
        account.beginAddingAccount()
        try await account.signIn(english)
        let englishSession = try XCTUnwrap(account.session)
        XCTAssertNotEqual(englishSession.keys.anonID, japaneseSession.keys.anonID)
        request(englishSession, held: lastLoad)
        await gate.waitForIdle()
        XCTAssertEqual(language, "en")
        XCTAssertEqual(roots, [englishSession.keys.anonID])
        try await account.switchAccount(to: japaneseSession.keys.anonID)
        let returnedSession = try XCTUnwrap(account.session)
        XCTAssertFalse(returnedSession === japaneseSession)
        request(returnedSession, held: lastLoad)
        await lastLoad.waitUntilEntered()
        await firstLoad.release(.success("ja"))
        await obsolete?.value
        XCTAssertTrue(gate.isPending)
        XCTAssertEqual(roots, [englishSession.keys.anonID])
        XCTAssertEqual(holds, [true, false, true])
        await lastLoad.release(.success("ja"))
        await gate.waitForIdle()
        let loaded = await counts.snapshot()
        XCTAssertEqual(loaded, ["ja", "ja"])
        XCTAssertEqual(language, "ja")
        XCTAssertEqual(roots, [englishSession.keys.anonID, returnedSession.keys.anonID])
        XCTAssertEqual(holds, [true, false, true, false])
        await account.session?.stop()
    }
}