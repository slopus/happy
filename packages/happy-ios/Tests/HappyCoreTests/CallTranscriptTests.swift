import Foundation
@testable import HappyCore
import XCTest

final class MemoryTranscriptStore: CallTranscriptStore, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var lines: [Data] = []
    func replace(_ first: Data) { lock.lock(); lines = [first]; lock.unlock() }
    func append(_ line: Data) { lock.lock(); lines.append(line); lock.unlock() }
    func read() -> Data? {
        lock.lock(); defer { lock.unlock() }
        return lines.isEmpty ? nil : Data(lines.joined(separator: Data("\n".utf8)))
    }
}

/// The last call's exchange with the connection, for developer mode (Android `CallTranscriptTest`).
@MainActor
final class CallTranscriptTests: XCTestCase {
    private var clock = 1_700_000_000.0
    private let events = CallEvents(activity: { _, _ in }, disconnected: {}, hungUp: {}, tool: { _ in CallToolResult(text: #"{"ok":true}"#) })

    private func transcript(_ store: any CallTranscriptStore = MemoryTranscriptStore(), limit: Int = CallTranscript.limitBytes) -> CallTranscript {
        CallTranscript(store: store, limit: limit) { [unowned self] in
            defer { clock += 0.25 }
            return clock
        }
    }

    /// Connects through the recorder, handing back what the connection was given.
    private func connect(_ transcript: CallTranscript, _ request: CallStart = CallStart(prompt: "the prompt", context: "the context", language: "en")) async throws -> (any CallConnection, CallEvents) {
        var given: CallEvents?
        let connection = try await transcript.record { _, _, events in
            given = events
            return FakeCallConnection()
        }(CallGrant(agentId: "g"), request, events)
        return (connection, try XCTUnwrap(given))
    }

    /// Everything that goes to the connection and comes from it, in order, each at its time.
    func testEveryKindIsRecordedInOrder() async throws {
        let transcript = transcript()
        let (connection, events) = try await connect(transcript)
        events.said("Hi, what's up?", 1)
        events.heard("what's new")
        let result = await events.tool(CallToolCall(id: "t1", name: "readConversation", parameters: Data(#"{"ref":"s1"}"#.utf8)))
        XCTAssertEqual(result.text, #"{"ok":true}"#)
        try await connection.update(#"{"event":"unfollowed","ref":"s4"}"#)
        try await connection.cue(#"{"event":"silence"}"#)
        events.corrected("Hi", 1)
        events.disconnected()
        await connection.end()
        let recording = try XCTUnwrap(transcript.read())
        XCTAssertEqual(recording.language, "en")
        XCTAssertEqual(recording.entries.map(\.kind), [.prompt, .context, .agent, .person, .toolCall, .toolResult, .update, .cue, .corrected, .ended, .ended])
        XCTAssertEqual(recording.entries.map(\.text), [
            "the prompt", "the context", "Hi, what's up?", "what's new", #"{"ref":"s1"}"#, #"{"ok":true}"#, #"{"event":"unfollowed","ref":"s4"}"#,
            #"[app] {"event":"silence"}"#, "Hi", "the connection dropped, or the provider ended it", "the app ended it",
        ])
        XCTAssertEqual(recording.entries.compactMap(\.name), ["readConversation", "readConversation"])
        XCTAssertEqual(recording.entries.map(\.at), recording.entries.map(\.at).sorted())
        XCTAssertEqual(recording.duration, recording.entries.last!.at - recording.started, accuracy: 0.0001)
        XCTAssertFalse(recording.truncated)
        let text = recording.text(in: TimeZone(identifier: "UTC")!)
        XCTAssertTrue(text.hasPrefix("Last voice call, started 2023-11-14 22:13:20, 0:02 long, language en\n"), text)
        XCTAssertTrue(text.contains("22:13:21.250  tool call readConversation\n{\"ref\":\"s1\"}\n"), text)
    }

    /// Through a call: what `CallSession` sends goes through the one recorded connection.
    func testACallsUpdatesAreRecorded() async throws {
        let transcript = transcript()
        let call = CallSession(grants: FakeGrants(.granted(CallGrant(agentId: "g"))), permission: { true },
                               connect: transcript.record { _, _, _ in FakeCallConnection() })
        call.start(language: nil, context: { "first context" }, tool: { _ in CallToolResult(text: "{}") })
        await waitUntil { if case .active = call.state { true } else { false } }
        call.deliver(CallUpdate(context: [#"{"event":"focus"}"#]))
        await call.delivered()
        let entries = try XCTUnwrap(transcript.read()).entries
        XCTAssertEqual(entries[1].kind, .context)
        XCTAssertEqual(entries[1].text, "first context")
        XCTAssertEqual(entries.last?.kind, .update)
        XCTAssertEqual(entries.last?.text, #"{"event":"focus"}"#)
        call.stop()
    }

    /// A new call replaces the last; what the old one still says goes nowhere.
    func testANewCallReplacesTheLast() async throws {
        let transcript = transcript()
        let (old, oldEvents) = try await connect(transcript, CallStart(prompt: "p", context: "first"))
        oldEvents.heard("from the first call")
        _ = try await connect(transcript, CallStart(prompt: "p", context: "second"))
        oldEvents.heard("late")
        try await old.update("late update")
        let recording = try XCTUnwrap(transcript.read())
        XCTAssertNil(recording.language)
        XCTAssertEqual(recording.entries.map(\.kind), [.prompt, .context])
        XCTAssertEqual(recording.entries.map(\.text), ["p", "second"])
    }

    /// Kept on disk: the next launch reads it, after the writes asked for.
    func testItIsKeptAcrossLaunches() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent("call-transcript.jsonl")
        XCTAssertNil(CallTranscript(store: FileCallTranscriptStore(url: url)).read())
        let (connection, events) = try await connect(transcript(FileCallTranscriptStore(url: url)))
        events.heard("hello")
        try await connection.update("an update")
        let read = try XCTUnwrap(CallTranscript(store: FileCallTranscriptStore(url: url)).read())
        XCTAssertEqual(read.started, 1_700_000_000, accuracy: 0.0001)
        XCTAssertEqual(read.entries.map(\.kind), [.prompt, .context, .person, .update])
        // A line a crash cut short is left out.
        let handle = try FileHandle(forWritingTo: url)
        _ = try handle.seekToEnd()
        try handle.write(contentsOf: Data(#"{"kind":"person","at":1"#.utf8))
        try handle.close()
        XCTAssertEqual(CallTranscript(store: FileCallTranscriptStore(url: url)).read()?.entries.count, 4)
    }

    /// Past its limit the rest isn't kept, once said so; how it ended still is.
    func testPastTheLimitItSaysItWasCut() async throws {
        let store = MemoryTranscriptStore()
        let transcript = transcript(store, limit: 1_000)
        let (connection, events) = try await connect(transcript)
        for _ in 0..<20 { try await connection.update(String(repeating: "x", count: 100)) }
        events.heard("too late")
        await connection.end()
        let recording = try XCTUnwrap(transcript.read())
        XCTAssertTrue(recording.truncated)
        XCTAssertEqual(recording.entries.filter { $0.kind == .truncated }.count, 1)
        XCTAssertFalse(recording.entries.contains { $0.kind == .person })
        XCTAssertEqual(recording.entries.last?.kind, .ended)
        XCTAssertLessThan(store.lines.reduce(0) { $0 + $1.count + 1 }, 1_400)
    }

    private func waitUntil(_ condition: () -> Bool) async {
        for _ in 0..<500 where !condition() { try? await Task.sleep(for: .milliseconds(2)) }
    }
}
