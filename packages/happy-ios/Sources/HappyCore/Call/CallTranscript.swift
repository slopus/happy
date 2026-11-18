import Foundation

/// Everything the last call exchanged with the voice connection, in order,
/// for developer mode's "Last voice call transcript": the prompt and
/// context it started with, every contextual update and cue as sent, each
/// tool call with its result, and the words both sides said. Recorded at
/// the connection itself (`record`), so nothing that goes to it or comes
/// from it is missed. Only the last call is kept, on this phone: a new one
/// replaces it, and past `limit` bytes the rest isn't kept, and the
/// transcript says so. Never logged, uploaded or counted.
@MainActor
public final class CallTranscript {
    public enum Kind: String, Codable, Sendable {
        case prompt, context, update
        /// The app's own turn for the agent (`CallCue`).
        case cue
        case toolCall, toolResult
        case agent
        /// The agent's words as they were heard: the person cut in.
        case corrected
        case person, ended, truncated

        public var label: String {
            switch self {
            case .prompt: "system prompt sent"
            case .context: "context sent"
            case .update: "update"
            case .cue: "app cue"
            case .toolCall: "tool call"
            case .toolResult: "tool result"
            case .agent: "agent said"
            case .corrected: "agent said, as heard"
            case .person: "you said"
            case .ended: "ended"
            case .truncated: "truncated"
            }
        }
    }

    /// One thing sent or received; `name` is a tool's. Times are seconds since 1970.
    public struct Entry: Codable, Equatable, Sendable {
        public var kind: Kind
        public var at: Double
        public var text: String
        public var name: String?
        public var isError: Bool?

        /// Its local time and what it is.
        public func heading(in zone: TimeZone = .current) -> String {
            "\(CallTranscript.format("HH:mm:ss.SSS", at, zone))  \(kind.label)" + (name.map { " \($0)" } ?? "") + (isError == true ? " (error)" : "")
        }
    }

    private struct Header: Codable {
        var format: Int
        var started: Double
        var language: String?
    }

    /// The last call as kept.
    public struct Recording: Equatable, Sendable {
        public var started: Double
        public var language: String?
        public var entries: [Entry]

        public var truncated: Bool { entries.contains { $0.kind == .truncated } }
        public var duration: Double { max(0, (entries.last?.at ?? started) - started) }

        /// All of it as plain text, times local, for copying elsewhere.
        public func text(in zone: TimeZone = .current) -> String {
            let seconds = Int(duration)
            let clock = seconds < 3600 ? String(format: "%d:%02d", seconds / 60, seconds % 60)
                : String(format: "%d:%02d:%02d", seconds / 3600, (seconds % 3600) / 60, seconds % 60)
            var text = "Last voice call, started \(CallTranscript.format("yyyy-MM-dd HH:mm:ss", started, zone)), \(clock) long"
            if let language { text += ", language \(language)" }
            text += "\n"
            for entry in entries { text += "\n\(entry.heading(in: zone))\n\(entry.text)\n" }
            return text
        }
    }

    /// The most of one call kept: an hour of updates fits.
    public nonisolated static let limitBytes = 4 * 1024 * 1024
    nonisolated static let format = 1

    private let store: any CallTranscriptStore
    private let now: () -> Double
    private let limit: Int
    /// This call's number: what an earlier call still says after it is let go.
    private var call = 0
    private var bytes = 0
    private var truncated = false

    public init(store: any CallTranscriptStore, limit: Int = CallTranscript.limitBytes, now: @escaping () -> Double = { Date().timeIntervalSince1970 }) {
        self.store = store
        self.limit = limit
        self.now = now
    }

    /// `connect`, with everything that goes to the connection and comes
    /// from it recorded as this call's.
    public func record(_ connect: @escaping CallSession.Connect) -> CallSession.Connect {
        { [self] grant, request, events in
            let current = began(request)
            let add: @MainActor @Sendable (Kind, String, String?, Bool) -> Void = { kind, text, name, isError in
                guard current == self.call else { return }
                self.keep(Entry(kind: kind, at: self.now(), text: text, name: name, isError: isError ? true : nil))
            }
            var recorded = events
            recorded.disconnected = { add(.ended, "the connection dropped, or the provider ended it", nil, false); events.disconnected() }
            recorded.hungUp = { add(.ended, "hung up", nil, false); events.hungUp() }
            recorded.tool = { call in
                await add(.toolCall, String(decoding: call.parameters, as: UTF8.self), call.name, false)
                let result = await events.tool(call)
                await add(.toolResult, result.text, call.name, result.isError)
                return result
            }
            recorded.heard = { text in add(.person, text, nil, false); events.heard(text) }
            recorded.said = { text, event in add(.agent, text, nil, false); events.said(text, event) }
            recorded.corrected = { text, event in add(.corrected, text, nil, false); events.corrected(text, event) }
            return Recorded(try await connect(grant, request, recorded), add: add)
        }
    }

    /// A new call: the last one's transcript goes, and this one starts
    /// with what it was started with.
    private func began(_ request: CallStart) -> Int {
        call += 1
        let header = (try? Self.encoder.encode(Header(format: Self.format, started: now(), language: request.language))) ?? Data()
        bytes = header.count + 1
        truncated = false
        store.replace(header)
        keep(Entry(kind: .prompt, at: now(), text: request.prompt))
        keep(Entry(kind: .context, at: now(), text: request.context))
        return call
    }

    /// Past `limit`, only how the call ended is kept, after a line saying
    /// the rest wasn't.
    private func keep(_ entry: Entry) {
        guard let line = try? Self.encoder.encode(entry) else { return }
        if truncated || bytes + line.count + 1 > limit, entry.kind != .ended {
            guard !truncated else { return }
            truncated = true
            let note = Entry(kind: .truncated, at: entry.at, text: "The rest of the call isn't kept: its transcript reached \(limit / 1024 / 1024) MB.")
            if let line = try? Self.encoder.encode(note) { store.append(line) }
            return
        }
        bytes += line.count + 1
        store.append(line)
    }

    /// The last call, or nil before there was one.
    public nonisolated static func read(from store: any CallTranscriptStore) -> Recording? {
        guard let data = store.read() else { return nil }
        let lines = data.split(separator: UInt8(ascii: "\n"))
        let decoder = JSONDecoder()
        guard let first = lines.first, let header = try? decoder.decode(Header.self, from: Data(first)), header.format == format else { return nil }
        // A line a crash cut short is left out.
        let entries = lines.dropFirst().compactMap { try? decoder.decode(Entry.self, from: Data($0)) }
        return Recording(started: header.started, language: header.language, entries: entries)
    }

    public func read() -> Recording? { Self.read(from: store) }

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        return encoder
    }()

    nonisolated static func format(_ pattern: String, _ at: Double, _ zone: TimeZone) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = zone
        formatter.dateFormat = pattern
        return formatter.string(from: Date(timeIntervalSince1970: at))
    }

    /// The connection, with what goes to it recorded first.
    private final class Recorded: CallConnection {
        private let connection: any CallConnection
        private let add: @MainActor @Sendable (Kind, String, String?, Bool) -> Void

        init(_ connection: any CallConnection, add: @escaping @MainActor @Sendable (Kind, String, String?, Bool) -> Void) {
            self.connection = connection
            self.add = add
        }

        func end() async {
            add(.ended, "the app ended it", nil, false)
            await connection.end()
        }

        func setMuted(_ muted: Bool) async throws { try await connection.setMuted(muted) }

        func update(_ context: String) async throws {
            add(.update, context, nil, false)
            try await connection.update(context)
        }

        func cue(_ facts: String) async throws {
            add(.cue, CallCue.mark + facts, nil, false)
            try await connection.cue(facts)
        }
    }
}

/// Where the last call's transcript is kept: one file of lines, replaced
/// whole, then added to.
public protocol CallTranscriptStore: Sendable {
    func replace(_ first: Data)
    func append(_ line: Data)
    func read() -> Data?
}

/// The transcript in `Application Support/Happy/call-transcript.jsonl`:
/// readable only while the phone is unlocked, never backed up. Writes go
/// one after another off the caller's thread; a read waits for them.
public struct FileCallTranscriptStore: CallTranscriptStore {
    private let url: URL

    public init(url: URL) {
        self.url = url
    }

    /// The device's one transcript; nil where the system gives no folder.
    public static func device() -> FileCallTranscriptStore? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            .map { FileCallTranscriptStore(url: $0.appendingPathComponent("Happy", isDirectory: true).appendingPathComponent("call-transcript.jsonl")) }
    }

    public func replace(_ first: Data) {
        Self.queue.async { [url] in
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            #if canImport(Darwin)
            try? (first + Data("\n".utf8)).write(to: url, options: [.atomic, .completeFileProtection])
            var excluded = url
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try? excluded.setResourceValues(values)
            #else
            try? (first + Data("\n".utf8)).write(to: url, options: .atomic)
            #endif
        }
    }

    public func append(_ line: Data) {
        Self.queue.async { [url] in
            guard let handle = try? FileHandle(forWritingTo: url) else { return }
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: line + Data("\n".utf8))
        }
    }

    public func read() -> Data? { Self.queue.sync { try? Data(contentsOf: url) } }

    private static let queue = DispatchQueue(label: "call-transcript", qos: .utility)
}
