#if (DEBUG || HAPPY_FIXTURES) && canImport(UIKit)
import CryptoKit
import Foundation
import HappyCore
import HappyStore
import HappyWire
@testable import HappyUI
import UIKit

private struct SplitOffline: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct SplitNoSocket: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// A paired computer that answers from fixtures: a few tasks and bots, and
/// one conversation every agent shares, for looking at the iPad's split
/// view with a Happy Agent home.
private actor DemoComputer: AgentTransport {
    private static let home = #"""
    {"cursor":"c1","profile":{"userId":null},"userSettings":[],"projects":[],"workspaces":[],
     "bots":[{"id":"research","name":"Research Assistant","agent":{"id":"research-agent","workspaceId":"w","status":"idle"}},
       {"id":"inbox","name":"Inbox Triage","agent":{"id":"inbox-agent","workspaceId":"w","status":"idle"}}],
     "tasks":[{"id":"ipad","name":"iPad split view","agent":{"id":"ipad-agent","workspaceId":"w","status":"idle","unread":{"reason":"finished"}}},
       {"id":"cache","name":"Ship the cache","agent":{"id":"cache-agent","workspaceId":"w","status":"idle"}},
       {"id":"notes","name":"Release notes","agent":{"id":"notes-agent","workspaceId":"w","status":"idle"}}],
     "taskMemberships":[{"taskId":"ipad"},{"taskId":"cache"},{"taskId":"notes"}],"surfaces":[]}
    """#

    private static func message(_ id: String, _ role: String, _ at: Double, _ text: String) -> JSONValue {
        .object(["id": .string(id), "role": .string(role), "createdAt": .number(at), "metadata": .object([:]),
                 "content": .array([.object(["type": .string("text"), "text": .string(text)])])])
    }

    /// With `rounds`, that many more questions and answers after the
    /// four, enough to scroll. `live`, for a live call (`CallLiveCheck`):
    /// 60 more tasks, three turns in every conversation, the last with
    /// commentary ahead of its answer, and a reply streamed to each message
    /// sent, or for Release notes a failure.
    private let rounds: Int
    private let live: Bool
    init(rounds: Int = 0, live: Bool = false) {
        self.rounds = rounds
        self.live = live
    }

    private var streams: [AsyncThrowingStream<Data, Error>.Continuation] = []
    private var eventId = 0
    /// The turns each message sent has made, by agent.
    private var sent: [String: [JSONValue]] = [:]
    /// Work the live call's computer made while it ran (`answer`).
    private var made: [JSONValue] = []

    private static func run(_ id: String, _ startedAt: Double, _ endedAt: Double?, reason: String = "completed", _ messages: [JSONValue]) -> JSONValue {
        var run: [String: JSONValue] = ["id": .string(id), "status": .string(endedAt == nil ? "running" : "completed"), "startedAt": .number(startedAt),
                                        "messages": .array(messages)]
        if let endedAt {
            run["endedAt"] = .number(endedAt)
            run["reason"] = .string(reason)
        }
        return .object(run)
    }

    private static let liveRuns: [JSONValue] = [
        run("r0", 500, 900, [message("u0", "user", 0.5, "Is the build green?"), message("m0", "agent", 0.6, "Yes, main is green.")]),
        run("r1", 1_000, 1_500, [message("u1", "user", 1, "How should the iPad lay out the app?"),
                                 message("m1", "agent", 2, "A sidebar and a main panel, with UIKit's own split view controller.")]),
        run("r2", 1_600, 2_000, [message("u2", "user", 3, "And when the sidebar is hidden?"),
                                 message("c2", "agent", 3.5, "Let me check how the sidebar hides."),
                                 message("m2", "agent", 4, "The main panel takes the whole window, and the transcript stays centred at its readable width.")]),
    ]

    private func history(_ agentId: String) -> [JSONValue] {
        (live ? Self.liveRuns : [run]) + (sent[agentId] ?? [])
    }

    private var run: JSONValue {
        guard case .object(var run) = Self.base, case .array(var messages)? = run["messages"] else { return Self.base }
        for round in 0..<rounds {
            let at = Double(5 + 2 * round)
            messages.append(Self.message("ru\(round)", "user", at, "Question \(round + 1): what moves when the window narrows?"))
            messages.append(Self.message("ra\(round)", "agent", at + 1, "Round \(round + 1). The sidebar folds into the stack, home at its root, and the main panel's screens follow it in order; widened, they go back where they were."))
        }
        run["messages"] = .array(messages)
        return .object(run)
    }

    private static let base: JSONValue = .object([
        "id": .string("r1"), "status": .string("completed"), "startedAt": .number(1_000), "endedAt": .number(2_000), "reason": .string("completed"),
        "messages": .array([
            message("u1", "user", 1, "How should the iPad lay out the app?"),
            message("m1", "agent", 2, """
            A **sidebar and a main panel**, with UIKit's own `UISplitViewController`:

            - The sidebar is home: the account's list, its switcher and search.
            - The main panel holds every screen opened from it, pushed on its own stack.
            - Narrowed below 768 points, the window becomes a phone again: one stack, home at its root.

            Text in the main panel keeps a readable width, so a line never runs across a 13-inch screen.
            """),
            message("u2", "user", 3, "And when the sidebar is hidden?"),
            message("m2", "agent", 4, "The main panel takes the whole window, and the transcript stays centred at its readable width. The sidebar's button, or ⌃⌘S, brings it back, and the window remembers which way it was left."),
        ]),
    ])

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) throws -> HTTP1Response {
        var value: JSONValue
        if path == "/v0/bootstrap/desktop" {
            value = try JSONDecoder().decode(JSONValue.self, from: Data(Self.home.utf8))
            if live, case .object(var home) = value, case .array(var tasks)? = home["tasks"], case .array(var memberships)? = home["taskMemberships"] {
                for n in 1...60 {
                    tasks.append(.object(["id": .string("fixture\(n)"), "name": .string("Fixture task \(n)"),
                                          "agent": .object(["id": .string("fixture\(n)-agent"), "workspaceId": .string("w"), "status": .string("idle")])]))
                    memberships.append(.object(["taskId": .string("fixture\(n)")]))
                }
                // A subtask under Ship the cache, as the sidebar nests it.
                if let index = tasks.firstIndex(where: { $0["id"] == .string("cache") }), case .object(var task) = tasks[index], case .object(var agent)? = task["agent"] {
                    agent["subtasks"] = .array([.object(["id": .string("hitrate-agent"), "workspaceId": .string("w"), "parentAgentId": .string("cache-agent"),
                                                         "title": .string("Measure the hit rate"), "status": .string("idle")])])
                    task["agent"] = .object(agent)
                    tasks[index] = .object(task)
                }
                for task in made {
                    tasks.insert(task, at: 3)
                    if let id = task["id"] { memberships.append(.object(["taskId": id])) }
                }
                home["tasks"] = .array(tasks)
                home["taskMemberships"] = .array(memberships)
                value = .object(home)
            }
        } else if path.contains("/messages?") {
            value = .object(["hasMore": .bool(false), "runs": .array(history(String(path.split(separator: "/")[2])))])
        } else if path.hasSuffix("/bootstrap"), path.hasPrefix("/v0/agents/") {
            let id = String(path.split(separator: "/")[2])
            value = .object(["agent": .object(["id": .string(id), "workspaceId": .string("w"), "status": .string("idle")]), "pending": .array([]),
                             "mode": .object(["providerId": .string("claude"), "modelId": .string("anthropic/sonnet-5"), "effort": .string("medium"),
                                              "permissionMode": .string("auto")])])
        } else if method == "PUT", path.hasSuffix("/file"), let body,
                  let content = try JSONDecoder().decode(JSONValue.self, from: body)["content"]?.stringValue,
                  let bytes = Data(base64Encoded: content) {
            // A picked video is kept in the workspace, as the computer would.
            value = .object(["hash": .string(SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined())])
        } else if method == "POST" {
            // What a call's tools would have changed on a real computer (`CallLiveCheck`).
            print("[computer] POST \(path) \(body.map { String(decoding: $0.prefix(400), as: UTF8.self) } ?? "")")
            if live, path.hasSuffix("/send"), let body, let sent = try? JSONDecoder().decode(JSONValue.self, from: body),
               let id = sent["id"]?.stringValue, let text = sent["text"]?.stringValue {
                let agentId = String(path.split(separator: "/")[2])
                Task { await answer(agentId, id: id, text: text) }
            }
            value = .object([:])
        } else {
            return .init(status: 404, body: Data("{}".utf8))
        }
        return .init(status: 200, body: try JSONEncoder().encode(value))
    }

    func stream(path: String, credential: String, headers: [String: String]) throws -> HTTP1Stream {
        let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        continuation.yield(Data("event: hello\ndata: {\"cursor\":\"c1\",\"resumed\":true}\n\n".utf8))
        streams.append(continuation)
        return .init(status: 200, body: body)
    }

    private func emit(_ type: String, _ payload: [String: JSONValue]) {
        eventId += 1
        let envelope: JSONValue = .object(["type": .string(type), "payload": .object(payload)])
        guard let data = try? JSONEncoder().encode(envelope) else { return }
        let frame = Data("id: e\(eventId)\ndata: ".utf8) + data + Data("\n\n".utf8)
        for stream in streams { stream.yield(frame) }
    }

    /// The turn a message sent starts, as the daemon's events tell it: the
    /// reply in pieces, or for Release notes a failure that stops it.
    private func answer(_ agentId: String, id: String, text: String) async {
        let runId = "s\(eventId)"
        let started = Date().timeIntervalSince1970 * 1000
        let agent = JSONValue.string(agentId)
        let user = Self.message(id, "user", started, text)
        func pause() async { try? await Task.sleep(for: .milliseconds(700)) }
        emit("message.created", ["agentId": agent, "runId": .string(runId), "message": user])
        emit("run.started", ["agentId": agent, "run": Self.run(runId, started, nil, []), "acceptedMessageIds": .array([.string(id)])])
        await pause()
        let ended: JSONValue
        if agentId == "notes-agent" {
            let reason = "The model provider is unavailable."
            guard case .object(var failure) = Self.message("\(runId)f", "service", started + 1, reason) else { return }
            failure["failure"] = .object(["kind": .string("provider_unavailable"), "message": .string(reason)])
            ended = .object(failure)
            emit("message.created", ["agentId": agent, "runId": .string(runId), "message": ended])
        } else {
            let pieces = ["I ran the tests. ", "All 214 passed, ", "and the cache ", "is ready to ship."]
            emit("message.created", ["agentId": agent, "runId": .string(runId), "message": Self.message("\(runId)a", "agent", started + 1, "")])
            var offset = 0
            for piece in pieces {
                await pause()
                emit("message.delta", ["agentId": agent, "runId": .string(runId), "messageId": .string("\(runId)a"), "blockIndex": .number(0),
                                       "offset": .number(Double(offset)), "append": .string(piece)])
                offset += piece.utf16.count
            }
            ended = Self.message("\(runId)a", "agent", started + 1, pieces.joined())
            emit("message.updated", ["agentId": agent, "runId": .string(runId), "message": ended])
        }
        await pause()
        let finished = Self.run(runId, started, Date().timeIntervalSince1970 * 1000, reason: agentId == "notes-agent" ? "error" : "completed", [user, ended])
        sent[agentId, default: []].append(finished)
        emit("run.finished", ["agentId": agent, "run": finished])
        // Its first answer makes new work, which the computer calls "New
        // Task" until a moment later it has a name, as the daemon does.
        if agentId == "cache-agent", made.isEmpty {
            await pause()
            func task(_ name: String) -> JSONValue {
                .object(["id": .string("bench"), "name": .string(name), "agent": .object(["id": .string("bench-agent"), "workspaceId": .string("w"), "status": .string("idle")])])
            }
            made = [task("New Task")]
            emit("task.created", ["taskId": .string("bench")])
            try? await Task.sleep(for: .milliseconds(400))
            made = [task("Benchmark the cache")]
            emit("task.updated", ["taskId": .string("bench")])
        }
    }

    func reset() {}
    func close() {}
}

/// The seeded computer's Happy CLI with `-composeMachine`: compose's first
/// send makes a Claude session there at once (its row written, as sync
/// would) instead of asking a computer that is offline.
private struct SplitComposeMachine: HomeOps, HomeSessionOps {
    static let sessionId = "split-compose-session"
    let store: LocalStore

    func machineSpawnNewSession(options: SpawnSessionOptions) async -> SpawnSessionResult {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let record = SessionRecord(
            id: Self.sessionId, seq: 0, createdAt: now, updatedAt: now, active: true, activeAt: now, projectId: nil,
            metadataVersion: 1, metadataCipher: "harness",
            metadata: .object([
                "path": .string(options.directory), "host": .string("harness-mac"), "homeDir": .string(SeededAccount.home),
                "machineId": .string(options.machineId), "flavor": .string(options.agent ?? "claude"), "version": .string("1.2.6"),
            ]),
            agentStateVersion: 1, agentStateCipher: nil, agentState: .object(["controlledByUser": .bool(false)]),
            dataKeyCipher: nil, decryptable: true
        )
        try? await Task.detached { [store] in try store.upsertSessions([record]) }.value
        return .success(sessionId: Self.sessionId)
    }
    func machineResumeSession(machineId: String, sessionId: String, model: String?, permissionMode: String?) async -> SpawnSessionResult { .error(errorMessage: "") }
    func forkAndSpawn(source: ForkSource, options: ForkOptions) async -> SpawnSessionResult { .error(errorMessage: "") }
    func machineStopSession(machineId: String, sessionId: String) async -> MachineOperationResult { try! JSONDecoder().decode(MachineOperationResult.self, from: Data(#"{"success":true}"#.utf8)) }
    func machineBash(machineId: String, command: String, cwd: String) async throws -> SessionBashResponse { throw URLError(.cannotConnectToHost) }

    func sessionKill(sessionId: String) async throws -> SessionKillResponse { throw URLError(.cannotConnectToHost) }
    func sessionSetAgentModes(sessionId: String, patch: SessionAgentModesPatch, transport: any MetadataUpdateTransport) async throws {}
    func sessionSetAvatar(sessionId: String, picture: SessionAvatarPicture) async throws {}
    func archive(sessionId: String) async throws {}
    func ensureSessionReady(sessionId: String) async throws {}
    func uploadSessionBlob(sessionId: String, name: String, bytes: Data) async throws -> (ref: String, size: Int) { throw URLError(.cannotConnectToHost) }

    @MainActor static func install() {
        LegacyComposeStart.makeStarter = { account in
            let machine = SplitComposeMachine(store: account.store)
            return SessionStarter(environment: .init(
                ops: machine,
                sessionOps: machine,
                sender: account.sender,
                metadataTransport: account.realtime,
                saveInitialModes: { [sender = account.sender] in try await sender.saveInitialModes(sessionId: $0, patch: $1) },
                refreshSessions: {},
                paintBotFace: { _ in throw URLError(.cannotConnectToHost) },
                attachmentPlan: { [sender = account.sender] message, sessionId in try await sender.attachmentPlan(for: message, sessionId: sessionId) },
                spawnRequests: account.spawnRequests
            ))
        }
    }
}

/// The whole app, offline, as an iPad shows it (`-screen split`): the
/// seeded Happy CLI account (`SeededAccount`), or with `-agent` a Happy
/// Agent answering from fixtures, under AppCoordinator's own split view.
///
/// For screenshots and recordings, after launch: `-open <session id or
/// agent id>` opens a chat from the sidebar, `-info` pushes its profile,
/// `-settings` opens Settings instead, `-hideSidebar` hides the sidebar,
/// `-dark` darkens the window, `-landscape` turns it on its side,
/// `-resizeLoop` narrows and widens the window in turn, `-narrow` leaves
/// an iPad's window 600 wide, `-animated` pushes the chat `-open` opens as
/// a tap does, for a recording of the push, `-linkLoop` has the switcher
/// say the link is down and up again in turn, `-probe` reads the open chat's list
/// (`ChatScrollProbe`), `-pageProbe` the open page's scroll view
/// (`PageScrollProbe`), `-long` gives the agent's conversation 60 more
/// rounds, `-composeMachine` lets compose's first send make a session on
/// the seeded computer (`SplitComposeMachine`), `-callLive <directory>`
/// talks to the build's hosted voice agent from files (`CallLiveCheck`).
@MainActor
final class SplitAppHarness {
    private var coordinator: AppCoordinator?
    private var recorder: FrameRecorder?
    private var probe: ChatScrollProbe?
    private var pageProbe: PageScrollProbe?
    #if DEBUG
    private var liveCall: CallLiveCheck?
    #endif

    init(window: UIWindow, arguments: [String]) {
        func option(_ name: String) -> String? {
            arguments.firstIndex(of: name).flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil }
        }
        let agent = arguments.contains("-agent")
        #if DEBUG
        if let directory = option("-callLive") {
            do { liveCall = try CallLiveCheck(directory: URL(fileURLWithPath: directory)) }
            catch { print("[call-live] \(error)") }
        }
        #endif
        if arguments.contains("-composeMachine") { SplitComposeMachine.install() }
        let computer = DemoComputer(rounds: arguments.contains("-long") ? 60 : 0, live: option("-callLive") != nil || arguments.contains("-voiceTouch"))
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/split-harness",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentConnectionCredentialStore: InMemoryAgentConnectionCredentialStore(),
            agentTransport: { _ in computer },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: SplitOffline(), connector: SplitNoSocket()
        )
        Task { @MainActor in
            do {
                if agent {
                    let credentials = try JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"split-harness","port":1,"deviceID":"split-harness","deviceToken":"fixture"}"#.utf8))
                    _ = try await controller.agentConnections.add(credentials, name: "Studio Mac")
                } else {
                    try await controller.signIn(Credentials(token: "split-harness", secret: Data(repeating: 29, count: 32)))
                    guard let store = controller.session?.store else { return }
                    try await Task.detached { try SeededAccount.seed(store) }.value
                }
            } catch { fatalError("Split harness: \(error)") }
            let context = AppContext(account: controller, variant: .development, version: "split-harness")
            let coordinator = AppCoordinator(window: window, context: context)
            self.coordinator = coordinator
            coordinator.start()
            if let seconds = option("-recordFrames").flatMap(Double.init) {
                self.recorder = FrameRecorder(window: window, seconds: seconds, top: option("-recordTop").flatMap(Double.init).map { CGFloat($0) })
            }
            try? await Task.sleep(for: .seconds(2))
            guard let shell = window.rootViewController as? ShellViewController, let home = shell.stack.first else { return }
            // After the account's own theme has been applied.
            if arguments.contains("-dark") { window.overrideUserInterfaceStyle = .dark }
            // An iPad's window narrowed to the one stack, as Split View leaves it.
            if arguments.contains("-narrow"), UIDevice.current.userInterfaceIdiom == .pad {
                window.frame = CGRect(x: 0, y: 0, width: 600, height: window.bounds.height)
                try? await Task.sleep(for: .milliseconds(500))
            }
            if arguments.contains("-landscape") {
                window.windowScene?.requestGeometryUpdate(.iOS(interfaceOrientations: .landscapeRight)) { error in print("split harness: \(error)") }
                try? await Task.sleep(for: .seconds(1))
            }
            if arguments.contains("-settings") {
                if agent {
                    SettingsViewController.open(context: context, computer: controller.agentConnections.activeID, from: home)
                } else {
                    home.push(.settings, context: context)
                }
            } else if let id = option("-open") {
                Self.open(id, from: home, context: context, agent: agent, animated: arguments.contains("-animated"))
                try? await Task.sleep(for: .seconds(1))
                if arguments.contains("-info"), let chat = shell.topViewController {
                    if let legacy = chat as? LegacyChatViewController {
                        legacy.push(.sessionInfo(id: legacy.sessionId), context: context)
                    } else if let session = controller.agentConnections.activeID.flatMap({ Session.session(for: $0, context: context) }) {
                        chat.navigationController?.pushViewController(SessionDetailViewController(session: session, agentId: id, title: "iPad split view", spaceId: nil), animated: true)
                    }
                }
            }
            // The chat list as the scroll tests read it (`ChatScrollProbe`).
            if arguments.contains("-probe"), let window = window as? HarnessWindow, let chat = shell.topViewController {
                self.probe = ChatScrollProbe(window: window, chat: chat)
            }
            if arguments.contains("-pageProbe"), let page = shell.topViewController {
                try? await Task.sleep(for: .seconds(1))
                self.pageProbe = PageScrollProbe(window: window, page: page)
            }
            if arguments.contains("-hideSidebar") {
                try? await Task.sleep(for: .milliseconds(500))
                shell.setSidebarHidden(true)
            }
            if arguments.contains("-resizeLoop") { await Self.resizeLoop(window) }
            #if DEBUG
            if arguments.contains("-callTour") { await Self.callTour(shell: shell, home: home, context: context, agent: agent) }
            // The call's opens one after another, then from Settings: each logs the stack it left (`[call] stack`).
            if arguments.contains("-callOpens"), let id = context.account.agentConnections.activeID, let session = Session.session(for: id, context: context) {
                try? await Task.sleep(for: .seconds(2))
                let targets = SessionCallTargets(session: session, shell: shell)
                for agentId in ["ipad-agent", "cache-agent", "notes-agent", "ipad-agent"] { _ = await targets.open(agentId) }
                if let chat = shell.topViewController { SettingsViewController.open(context: context, computer: id, from: chat) }
                try? await Task.sleep(for: .seconds(1.5))
                _ = await targets.open("inbox-agent")
                _ = await targets.open("cache-agent")
                targets.close()
            }
            // The call's new work off screen by message, and navigate's destinations, through its own context, with no provider:
            // each logs its result and the stack it left (`[call-nav]`), a pause between for screenshots.
            if arguments.contains("-callNav"), let id = context.account.agentConnections.activeID, let session = Session.session(for: id, context: context) {
                try? await Task.sleep(for: .seconds(2))
                let targets = SessionCallTargets(session: session, shell: shell)
                let call = CallContext(targets: targets)
                var revision = 0
                @MainActor func step(_ name: String, _ json: String) async -> [String: Any] {
                    let result = await call.handle(CallToolCall(id: UUID().uuidString, name: name, parameters: Data(json.utf8)))
                    let value = (try? JSONSerialization.jsonObject(with: Data(result.text.utf8))) as? [String: Any] ?? [:]
                    if let next = value["focusRevision"] as? Int { revision = next }
                    print("[call-nav] \(name) \(result.isError ? "refused" : "ok") \(result.text)")
                    print("[call-nav] stack \(shell.stack.map { ($0 as? ChatViewController)?.shownAgentId ?? String(describing: type(of: $0)) })")
                    try? await Task.sleep(for: .seconds(2.5))
                    return value
                }
                let initial = await call.initial()
                print("[call-nav] initial\n\(initial)")
                _ = await step("navigate", "{\"to\":\"happy://conversation/s1\",\"focusRevision\":\(revision)}")
                // No such place: it says which there are.
                _ = await step("navigate", "{\"to\":\"happy://settings\",\"focusRevision\":\(revision)}")
                // Started off screen with its first message: what is in front stays.
                let task = await step("message", "{\"to\":\"new-task\",\"text\":\"Draft the release notes\"}")
                let made = (task["ref"] as? String) ?? ""
                _ = await step("readConversation", "{\"ref\":\"\(made)\"}")
                _ = await step("listConversations", "{}")
                _ = await step("navigate", "{\"to\":\"happy://conversation/\(made)\",\"focusRevision\":\(revision)}")
                // No to: the conversation on screen.
                _ = await step("message", "{\"text\":\"And the changelog\"}")
                _ = await step("navigate", "{\"to\":\"happy://back\",\"focusRevision\":\(revision)}")
                _ = await step("navigate", "{\"to\":\"happy://home\",\"focusRevision\":\(revision)}")
                _ = await step("navigate", "{\"to\":\"happy://back\",\"focusRevision\":\(revision)}")
                // Nothing on screen: the agent is told to ask which.
                _ = await step("message", "{\"text\":\"Anyone?\"}")
                _ = await step("readConversation", "{\"ref\":\"s1\"}")
                print("[call-nav] done")
                await call.close()
                targets.close()
            }
            // What the call presses, as the person would (`VoiceTouch`): compose for new work, a row off
            // screen and one on it, back, a sheet's close and home, each logged with when it began and
            // ended (`[voice-touch]`), a pause between for the recording.
            if arguments.contains("-voiceTouch"), let id = context.account.agentConnections.activeID, let session = Session.session(for: id, context: context) {
                // Less motion, as the system's setting asks for it.
                if arguments.contains("-reduceMotion") { ShimmerClock.shared.reduceMotionOverride = true }
                try? await Task.sleep(for: .seconds(3))
                let targets = SessionCallTargets(session: session, shell: shell)
                let call = CallContext(targets: targets)
                var revision = 0
                let began = Date()
                @MainActor func step(_ name: String, _ json: String) async -> [String: Any] {
                    print("[voice-touch] \(String(format: "%.2f", Date().timeIntervalSince(began))) start \(name) \(json)")
                    let result = await call.handle(CallToolCall(id: UUID().uuidString, name: name, parameters: Data(json.utf8)))
                    let value = (try? JSONSerialization.jsonObject(with: Data(result.text.utf8))) as? [String: Any] ?? [:]
                    if let next = value["focusRevision"] as? Int { revision = next }
                    print("[voice-touch] \(String(format: "%.2f", Date().timeIntervalSince(began))) end \(name) \(result.isError ? "refused" : "ok") \(result.text.prefix(200))")
                    try? await Task.sleep(for: .seconds(2))
                    return value
                }
                _ = await call.initial()
                let listed = await step("listConversations", "{}")
                let conversations = listed["conversations"] as? [[String: Any]] ?? []
                func ref(_ title: String) -> String { (conversations.first { $0["title"] as? String == title }?["ref"] as? String) ?? "" }
                let far = (conversations.last { ($0["title"] as? String)?.hasPrefix("Fixture task") == true }?["title"] as? String) ?? ""
                _ = await step("message", "{\"to\":\"new-task\",\"text\":\"Draft the release notes\"}")
                _ = await step("navigate", "{\"to\":\"happy://conversation/\(ref(far))\",\"focusRevision\":\(revision)}")
                _ = await step("navigate", "{\"to\":\"happy://back\",\"focusRevision\":\(revision)}")
                _ = await step("navigate", "{\"to\":\"happy://conversation/\(ref("Research Assistant"))\",\"focusRevision\":\(revision)}")
                _ = await step("navigate", "{\"to\":\"happy://home\",\"focusRevision\":\(revision)}")
                // A sheet with its close at the leading end, as the app's sheets have it.
                let settings = SettingsViewController(context: context, computer: id)
                let sheet = UINavigationController(rootViewController: settings)
                settings.navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .close, primaryAction: UIAction { [weak sheet] _ in sheet?.dismiss(animated: true) })
                AppCoordinator.applyAppearance(to: sheet.navigationBar)
                shell.present(sheet, animated: true)
                try? await Task.sleep(for: .seconds(2))
                _ = await step("navigate", "{\"to\":\"happy://back\",\"focusRevision\":\(revision)}")
                print("[voice-touch] done")
                await call.close()
                targets.close()
            }
            // A sheet of the app's over home, left up, for the UI test that reads the bar through it.
            if arguments.contains("-callSheet") {
                try? await Task.sleep(for: .seconds(1.5))
                let navigation = UINavigationController(rootViewController: SettingsViewController(context: context, computer: context.account.agentConnections.activeID))
                AppCoordinator.applyAppearance(to: navigation.navigationBar)
                shell.present(navigation, animated: true)
            }
            #endif
            if arguments.contains("-linkLoop"), let bar = home.navigationController?.navigationBar {
                func find(_ view: UIView) -> AccountSwitcherButton? {
                    if let button = view as? AccountSwitcherButton { return button }
                    return view.subviews.lazy.compactMap(find).first
                }
                for step in 0..<6 {
                    try? await Task.sleep(for: .seconds(1.5))
                    find(bar)?.setStatus(step.isMultiple(of: 2) ? "Waiting for network…" : nil, animated: true, bar: bar)
                }
            }
        }
    }

    /// Narrow and wide in turn, as Split View or Stage Manager would leave
    /// the window, for a recording of the stack being rewritten: 600 wide
    /// (one stack), then the scene's whole width (the split), every 3 s.
    private static func resizeLoop(_ window: UIWindow) async {
        let whole = window.bounds
        for step in 0..<8 {
            try? await Task.sleep(for: .seconds(3))
            let width = step.isMultiple(of: 2) ? 600 : whole.width
            window.frame = CGRect(x: 0, y: 0, width: width, height: whole.height)
        }
    }

    #if DEBUG
    /// With `HAPPY_CALL_FIXTURE` drawing a call: the bar over a chat,
    /// Settings, a sheet, the scanner and a full-screen sheet of the app's,
    /// then hung up under a sheet, logging what each presentation was given
    /// (`CallPresentations`) for the screenshots taken meanwhile.
    private static func callTour(shell: ShellViewController, home: UIViewController, context: AppContext, agent: Bool) async {
        func log(_ step: String) {
            var line = "[call-tour] \(step) bar=\(shell.callBarShown ? shell.callBar.barHeight : 0)"
            var next = shell.presentedViewController
            while let presented = next {
                let top = presented.view.window.map { presented.view.convert(presented.view.bounds, to: $0).minY } ?? -1
                let detents = presented.sheetPresentationController?.detents.map(\.identifier.rawValue).joined(separator: ",") ?? "-"
                let echoes = presented.presentationController?.containerView?.subviews.filter { $0.accessibilityIdentifier == "call-bar-echo" }.count ?? 0
                line += " | \(type(of: presented)) top=\(top) extraTop=\(presented.additionalSafeAreaInsets.top) safeTop=\(presented.view.safeAreaInsets.top) detents=\(detents) echo=\(echoes)"
                next = presented.presentedViewController
            }
            print(line)
        }
        func top() -> UIViewController {
            var top: UIViewController = shell
            while let next = top.presentedViewController { top = next }
            return top
        }
        func wait(_ seconds: Double) async { try? await Task.sleep(for: .seconds(seconds)) }
        func sheet() -> UINavigationController {
            let navigation = UINavigationController(rootViewController: SettingsViewController(context: context, computer: context.account.agentConnections.activeID))
            AppCoordinator.applyAppearance(to: navigation.navigationBar)
            return navigation
        }
        await wait(2)
        log("home")
        open("ipad-agent", from: home, context: context, agent: agent, animated: true)
        await wait(3); log("chat")
        if let chat = shell.topViewController { SettingsViewController.open(context: context, computer: context.account.agentConnections.activeID, from: chat) }
        await wait(3); log("settings")
        top().present(sheet(), animated: true)
        await wait(3); log("sheet")
        top().dismiss(animated: true)
        await wait(1.5)
        top().present(QRScannerViewController(), animated: true)
        await wait(3); log("scanner")
        top().dismiss(animated: true)
        await wait(1.5)
        top().present(QRSheetViewController(name: "Studio Mac", image: nil, isAgentConnection: true), animated: true)
        await wait(3); log("full-screen sheet")
        // Turned and back, its inset follows the bar and comes back to the same.
        let scene = shell.view.window?.windowScene
        scene?.requestGeometryUpdate(.iOS(interfaceOrientations: .landscapeRight))
        await wait(2.5); log("full-screen sheet, landscape")
        scene?.requestGeometryUpdate(.iOS(interfaceOrientations: .portrait))
        await wait(2.5); log("full-screen sheet, portrait again")
        top().dismiss(animated: true)
        await wait(1.5)
        top().present(sheet(), animated: true)
        await wait(3); log("sheet again")
        CallController.shared.close()
        await wait(2); log("hung up under the sheet")
        top().dismiss(animated: true)
        await wait(2); log("done")
    }
    #endif

    /// What tapping the row does: a chat from the sidebar.
    private static func open(_ id: String, from home: UIViewController, context: AppContext, agent: Bool, animated: Bool = false) {
        if agent {
            guard let session = context.account.agentConnections.activeID.flatMap({ Session.session(for: $0, context: context) }),
                  let row = session.home.rows.first(where: { $0.agentId == id }) else { return }
            home.navigationController?.pushViewController(ChatViewController(session: session, agentId: id, title: row.label, spaceId: row.spaceId, intro: nil), animated: animated)
        } else {
            home.push(.session(id: id), context: context, animated: animated)
        }
    }
}
/// A page's scroll view as the UI tests read it (an element named
/// `page-scroll-probe`): its offset and how far it scrolls, and every
/// change to its offset or insets made while neither a finger nor a glide
/// was moving it. Something laying the page out under the reader shows
/// there.
@MainActor
final class PageScrollProbe: NSObject {
    private let element = ProbeElement(frame: CGRect(x: 0, y: 0, width: 2, height: 2))
    private weak var scroll: UIScrollView?
    private var observations: [NSKeyValueObservation] = []
    private var foreignOffsets = 0
    private var insetChanges = 0

    init(window: UIWindow, page: UIViewController) {
        super.init()
        scroll = Self.scrollView(in: page.view)
        element.isAccessibilityElement = true
        element.accessibilityIdentifier = "page-scroll-probe"
        element.isUserInteractionEnabled = false
        element.alpha = 0.02
        element.read = { [weak self] in self?.report() ?? "{}" }
        window.addSubview(element)
        guard let scroll else { return }
        observations.append(scroll.observe(\.contentOffset, options: [.old, .new]) { [weak self] view, change in
            MainActor.assumeIsolated {
                guard change.oldValue != change.newValue, !view.isTracking, !view.isDragging, !view.isDecelerating else { return }
                self?.foreignOffsets += 1
            }
        })
        observations.append(scroll.observe(\.contentInset, options: [.old, .new]) { [weak self] _, change in
            MainActor.assumeIsolated { if change.oldValue != change.newValue { self?.insetChanges += 1 } }
        })
    }

    private static func scrollView(in view: UIView) -> UIScrollView? {
        if let scroll = view as? UIScrollView { return scroll }
        for child in view.subviews { if let found = scrollView(in: child) { return found } }
        return nil
    }

    private func report() -> String {
        guard let scroll else { return "{}" }
        let top = -scroll.adjustedContentInset.top
        let value: [String: Any] = [
            "offsetY": scroll.contentOffset.y - top,
            "maxOffsetY": max(0, scroll.contentSize.height + scroll.adjustedContentInset.bottom - scroll.bounds.height - top),
            "offsetX": scroll.contentOffset.x + scroll.adjustedContentInset.left,
            "foreignOffsets": foreignOffsets,
            "insetChanges": insetChanges,
        ]
        let data = (try? JSONSerialization.data(withJSONObject: value)) ?? Data()
        return String(decoding: data, as: UTF8.self)
    }
}
#endif
