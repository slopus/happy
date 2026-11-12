import Foundation
import HappyWire

/// A refused or failed Happy Agent request.
public enum AgentClientError: Error, Equatable, Sendable {
    /// The daemon answered with an error status; `code` is its error code.
    case status(Int, code: String?, message: String?)
    /// The device was unpaired.
    case revoked
    /// An answer that could not be read.
    case invalidResponse

    public var status: Int? {
        if case .status(let status, _, _) = self { return status }
        return nil
    }
}

/// The Happy Agent API over one paired device's private tunnel. Every route is
/// one a device token may use (happy-agent `API.md`, "Mobile connector").
public final class AgentClient: Sendable {
    let transport: any AgentTransport
    let token: String
    /// A team server signed in to: refused, it wants signing in again,
    /// not pairing.
    public let signsIn: Bool
    /// How the artifact pages read through it ask to be shown.
    public let pageModes = ArtifactPageModes()
    /// Whether the computer takes this device's environment, and what it was last told.
    public let environment = UserEnvironmentReports()

    init(transport: any AgentTransport, token: String, signsIn: Bool = false) {
        self.transport = transport
        self.token = token
        self.signsIn = signsIn
    }

    public func close() async { await transport.close() }
    /// Back from the background: see `AgentTransport.resumed`.
    public func resumed() async { await transport.resumed() }

    // MARK: Requests

    #if DEBUG
    /// `V2_SLOW_WRITES` seconds before every write, for a test that
    /// watches what shows before the computer answers.
    private static let slowWrites = ProcessInfo.processInfo.environment["HAPPY_SLOW_WRITES"].flatMap(Double.init)
    #endif

    /// `raw` is sent as is, in place of `json` (an upload's bytes).
    /// `sent` hears the body's bytes as they are written.
    func send(_ method: String, _ path: String, json: JSONValue? = nil, raw: Data? = nil, headers: [String: String] = [:], category: RequestCategory = .query,
              sent: (@Sendable (Int) -> Void)? = nil) async throws -> HTTP1Response {
        #if DEBUG
        if method != "GET", let slow = Self.slowWrites { try await Task.sleep(for: .seconds(slow)) }
        #endif
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        let body = try raw ?? json.map { try encoder.encode($0) }
        let response: HTTP1Response
        if let sent, let body, headers.isEmpty {
            // An upload whose progress is heard.
            response = try await transport.send(method: method, path: path, credential: token, body: body, category: category, sent: sent)
            if response.status == 401 { throw AgentClientError.revoked }
            return try Self.checked(response)
        }
        if let sent, let body {
            response = try await transport.send(method: method, path: path, credential: token, body: body, headers: headers, category: category, sent: sent)
        } else {
            response = try await transport.request(method: method, path: path, credential: token, body: body, headers: headers, category: category)
        }
        if response.status == 401 { throw AgentClientError.revoked }
        return try Self.checked(response)
    }

    private static func checked(_ response: HTTP1Response) throws -> HTTP1Response {
        guard (200..<300).contains(response.status) || response.status == 304 || response.status == 206 else {
            // Flat (`{error, code}`) or nested (`{error: {code, message}}`).
            let failure = try? JSONValue.decode(response.body)
            let nested = failure?["error"]?.objectValue
            throw AgentClientError.status(response.status, code: failure?["code"]?.stringValue ?? nested?["code"]?.stringValue,
                                          message: failure?["error"]?.stringValue ?? nested?["message"]?.stringValue)
        }
        return response
    }

    func decode<T: Decodable>(_ type: T.Type, _ method: String, _ path: String, json: JSONValue? = nil) async throws -> T {
        let response = try await send(method, path, json: json)
        if T.self == JSONValue.self {
            guard let value = try? JSONValue.decode(response.body) as? T else { throw AgentClientError.invalidResponse }
            return value
        }
        do { return try JSONDecoder().decode(T.self, from: response.body) }
        catch { throw AgentClientError.invalidResponse }
    }

    // MARK: Health and settings

    public func health() async throws -> AgentWire.Health {
        try await decode(AgentWire.Health.self, "GET", "/v0/health")
    }

    /// Tells the computer this device's environment (`PUT /v0/environment`),
    /// when its health says it takes one and it changed since it was last
    /// told. Health is asked until it says yes: a computer updated while
    /// the app runs starts taking reports. A 404 is a computer that doesn't.
    public func reportEnvironment(_ environment: UserEnvironment, deviceId: String) async throws {
        if self.environment.takesReports != true {
            let takes = try await health().capabilities?.userEnvironment == true
            self.environment.serves(takes, deviceId: deviceId)
            guard takes else { return }
        }
        guard !self.environment.told(environment) else { return }
        do { _ = try await send("PUT", "/v0/environment", json: environment.report(deviceId: deviceId)) }
        catch AgentClientError.status(404, _, _) {
            self.environment.serves(false, deviceId: deviceId)
            return
        }
        self.environment.remember(environment)
    }

    public func userSetting(_ key: String) async throws -> JSONValue? {
        struct Response: Decodable { let setting: AgentWire.Setting }
        do { return try await decode(Response.self, "GET", "/v0/user-settings/\(Self.escape(key))").setting.value }
        catch AgentClientError.status(404, _, _) { return nil }
    }

    public func setUserSetting(_ key: String, _ value: JSONValue) async throws {
        _ = try await send("PUT", "/v0/user-settings/\(Self.escape(key))", json: .object(["value": value]))
    }

    // MARK: Spaces

    public func sidebar(widgets: Bool) async throws -> AgentWire.SidebarResponse {
        try await decode(AgentWire.SidebarResponse.self, "GET", widgets ? "/v0/spaces/sidebar?widgets=true" : "/v0/spaces/sidebar")
    }

    public func applySidebarOperations(mutationId: String, baseVersion: Int, operations: [SpaceSidebarOperation]) async throws -> AgentWire.OperationsResponse {
        let json: JSONValue = .object([
            "mutationId": .string(mutationId), "baseVersion": .number(Double(baseVersion)),
            "operations": .array(operations.map(\.json)),
        ])
        let value = try await decode(JSONValue.self, "POST", "/v0/spaces/sidebar/operations", json: json)
        guard let artifactId = value["artifactId"]?.stringValue, let version = value["version"]?.numberValue,
              let html = value["html"]?.stringValue else { throw AgentClientError.invalidResponse }
        let operations = try (value["operations"]?.arrayValue ?? []).map {
            guard let operation = SpaceSidebarOperation(json: $0) else { throw AgentClientError.invalidResponse }
            return operation
        }
        return AgentWire.OperationsResponse(artifactId: artifactId, version: Int(version), html: html, operations: operations)
    }

    public func reportAttention(_ state: String) async throws {
        _ = try await send("POST", "/v0/spaces/attention", json: .object(["state": .string(state)]))
    }

    public func tidy(mutationId: String) async throws {
        _ = try await send("POST", "/v0/spaces/tidy", json: .object(["mutationId": .string(mutationId)]))
    }

    // MARK: Bots and tasks

    /// Every bot as sent, so its embedded agent can be normalized.
    public func bots() async throws -> [JSONValue] {
        try await decode(JSONValue.self, "GET", "/v0/bots")["bots"]?.arrayValue ?? []
    }

    /// Makes a task the person owns and joins (`POST /v0/tasks`), named by
    /// this phone; the same `id` again answers the same task. Unnamed, it is
    /// "New Task" until its first message names it, as desktop's blank
    /// name does. Its conversation's ID, as the computer gives it.
    public func createTask(_ identity: Identity, mutationId: String, name: String? = nil) async throws -> String {
        let answer = try await decode(JSONValue.self, "POST", "/v0/tasks", json: Self.creation(identity, mutationId: mutationId, name: name))
        guard let agentId = answer["task"]?["agent"]?["id"]?.stringValue else { throw AgentClientError.invalidResponse }
        return agentId
    }

    /// Makes a bot (`POST /v0/bots`) under the names this phone gives it,
    /// as desktop's `createBot` does; the same `mutationId` again answers
    /// the same bot. Unnamed, the computer names it from its first message
    /// ("New Bot" until then). Its conversation's ID, as the computer gives it.
    public func createBot(_ identity: Identity, mutationId: String, name: String? = nil) async throws -> String {
        let answer = try await decode(JSONValue.self, "POST", "/v0/bots", json: Self.creation(identity, mutationId: mutationId, name: name))
        guard let agentId = answer["bot"]?["agent"]?["id"]?.stringValue else { throw AgentClientError.invalidResponse }
        return agentId
    }

    /// A task's or bot's names; a blank name is left out rather than sent,
    /// which the computer would refuse.
    private static func creation(_ identity: Identity, mutationId: String, name: String?) -> JSONValue {
        var fields: [String: JSONValue] = [
            "id": .string(identity.taskId), "mutationId": .string(mutationId),
            "agentId": .string(identity.agentId), "workspaceId": .string(identity.workspaceId),
        ]
        if let name = name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty { fields["name"] = .string(name) }
        return .object(fields)
    }

    /// The tasks the person joined, as sent, each holding the person's own
    /// membership of it (`memberships[]`, matched by `taskId`) as `membership`.
    public func tasks() async throws -> [JSONValue] {
        let answer = try await decode(JSONValue.self, "GET", "/v0/tasks?scope=joined")
        var memberships: [String: JSONValue] = [:]
        for membership in answer["memberships"]?.arrayValue ?? [] {
            if let taskId = membership["taskId"]?.stringValue { memberships[taskId] = membership }
        }
        return (answer["tasks"]?.arrayValue ?? []).map { task in
            guard var object = task.objectValue, let id = object["id"]?.stringValue, let membership = memberships[id] else { return task }
            object["membership"] = membership
            return .object(object)
        }
    }

    // MARK: People

    /// The person this device is paired as, and their name. Standalone,
    /// `GET /v0/users` names only guests, so the reader's own name is read here.
    public func profileUser() async throws -> (id: String, name: String)? {
        let profile = try await decode(JSONValue.self, "GET", "/v0/profile")["profile"]
        guard let id = profile?["userId"]?.stringValue else { return nil }
        return (id, profile?["name"]?.stringValue ?? "")
    }

    /// People by ID (at most 100 a read), as named; unknown ones are left out.
    public func userNames(_ ids: [String]) async throws -> [String: String] {
        guard !ids.isEmpty else { return [:] }
        let answer = try await decode(JSONValue.self, "GET", "/v0/users?ids=" + ids.prefix(100).map(Self.escape).joined(separator: ","))
        var names: [String: String] = [:]
        for user in answer["users"]?.arrayValue ?? [] {
            if let id = user["id"]?.stringValue { names[id] = user["name"]?.stringValue ?? "" }
        }
        return names
    }

    /// `mutationId`: the same for every try of one rename, so the computer
    /// does it once (an intent's ID, `IntentOutbox`).
    public func renameTask(_ taskId: String, name: String, mutationId: String = ClientID.make()) async throws {
        try await rename("/v0/tasks/\(Self.escape(taskId))", key: "task", name: name, mutationId: mutationId)
    }

    public func renameBot(_ botId: String, name: String, mutationId: String = ClientID.make()) async throws {
        try await rename("/v0/bots/\(Self.escape(botId))", key: "bot", name: name, mutationId: mutationId)
    }

    public func leaveTask(_ taskId: String, mutationId: String = ClientID.make()) async throws {
        _ = try await send("POST", "/v0/tasks/\(Self.escape(taskId))/leave", json: .object(["mutationId": .string(mutationId)]))
    }

    public func archiveTask(_ taskId: String) async throws {
        try await archive("/v0/tasks/\(Self.escape(taskId))", key: "task")
    }

    public func archiveBot(_ botId: String) async throws {
        try await archive("/v0/bots/\(Self.escape(botId))", key: "bot")
    }

    /// A subtask's conversation (`POST /v0/agents/:agentId/archive`).
    public func archiveAgent(_ agentId: String, mutationId: String = ClientID.make()) async throws {
        _ = try await send("POST", "/v0/agents/\(Self.escape(agentId))/archive", json: .object(["mutationId": .string(mutationId)]))
    }

    /// Archival names the version it archives (`If-Match`).
    private func archive(_ path: String, key: String) async throws {
        guard let version = try await decode(JSONValue.self, "GET", path)[key]?["version"]?.stringValue else { throw AgentClientError.invalidResponse }
        _ = try await send("POST", path + "/archive", json: .object([:]), headers: ["If-Match": version])
    }

    /// A rename names the version it renames (`If-Match`); one that lost a
    /// race reads the newer version and renames that.
    private func rename(_ path: String, key: String, name: String, mutationId: String) async throws {
        for attempt in 0..<2 {
            guard let version = try await decode(JSONValue.self, "GET", path)[key]?["version"]?.stringValue else { throw AgentClientError.invalidResponse }
            do {
                _ = try await send("PATCH", path, json: .object(["name": .string(name), "mutationId": .string(mutationId)]), headers: ["If-Match": version])
                return
            } catch AgentClientError.status(409, _, _) where attempt == 0 {
                continue
            }
        }
    }

    // MARK: Surfaces

    /// Puts a Surface in the reader's sidebar, at its end; one already there stays where it is.
    public func joinSurface(_ surfaceId: String, mutationId: String = ClientID.make()) async throws {
        _ = try await send("POST", "/v0/surfaces/\(Self.escape(surfaceId))/join", json: .object(["mutationId": .string(mutationId)]))
    }

    /// Takes a Surface out of the reader's sidebar; its content stays for everyone.
    public func leaveSurface(_ surfaceId: String, mutationId: String = ClientID.make()) async throws {
        _ = try await send("POST", "/v0/surfaces/\(Self.escape(surfaceId))/leave", json: .object(["mutationId": .string(mutationId)]))
    }

    /// The joined Surfaces; nil where the daemon serves none (`404`, `501`).
    public func surfaces() async throws -> [AgentWire.Surface]? {
        struct Response: Decodable { let surfaces: [Lossy<AgentWire.Surface>] }
        do { return try await decode(Response.self, "GET", "/v0/surfaces").surfaces.compactMap(\.value) }
        catch AgentClientError.status(404, _, _), AgentClientError.status(501, _, _) { return nil }
    }

    /// A document as Markdown, its read-only projection.
    public func document(_ surfaceId: String) async throws -> String {
        try await decode(JSONValue.self, "GET", "/v0/surfaces/document/\(Self.escape(surfaceId))")["document"]?["text"]?.stringValue ?? ""
    }

    // MARK: Conversations

    public func agent(_ agentId: String) async throws -> AgentWire.Agent {
        struct Response: Decodable { let agent: AgentWire.Agent }
        return try await decode(Response.self, "GET", "/v0/agents/\(Self.escape(agentId))").agent
    }

    public func bootstrap(_ agentId: String) async throws -> AgentWire.Bootstrap {
        try await decode(AgentWire.Bootstrap.self, "GET", "/v0/agents/\(Self.escape(agentId))/bootstrap")
    }

    /// The same snapshot, read for a conversation's detail.
    public func sessionDetail(_ agentId: String) async throws -> AgentWire.Detail {
        try await decode(AgentWire.Detail.self, "GET", "/v0/agents/\(Self.escape(agentId))/bootstrap")
    }

    /// Newest runs first page, or the runs before `before`, or the messages after `after`.
    /// `limit` is desktop's page (`DEFAULT_HISTORY_LIMIT`). Tool data is left
    /// out: the phone shows none of a tool's input or output, only its pictures,
    /// which come on their own (`media`).
    public func messages(_ agentId: String, before: String? = nil, after: String? = nil, limit: Int = 100) async throws -> AgentWire.MessagesResponse {
        var query = "limit=\(limit)&omitToolData=true"
        if let before { query += "&before=\(Self.escape(before))" }
        if let after { query += "&after=\(Self.escape(after))" }
        return try await decode(AgentWire.MessagesResponse.self, "GET", "/v0/agents/\(Self.escape(agentId))/messages?\(query)")
    }

    /// One tool call's whole block, raw data included: the run `before`
    /// names the run after it (nil for the newest run), read alone with its
    /// tool data, which the transcript's own pages leave out. Nil when the
    /// run has no such call.
    public func toolCall(_ agentId: String, id: String, before: String?) async throws -> JSONValue? {
        var query = "limit=1&omitToolData=false"
        if let before { query += "&before=\(Self.escape(before))" }
        let page = try await decode(JSONValue.self, "GET", "/v0/agents/\(Self.escape(agentId))/messages?\(query)")
        for run in page["runs"]?.arrayValue ?? [] {
            for message in run["messages"]?.arrayValue ?? [] {
                for block in message["content"]?.arrayValue ?? [] where block["type"]?.stringValue == "tool_call" && block["id"]?.stringValue == id {
                    return block
                }
            }
        }
        return nil
    }

    /// The mode a conversation with no last composer mode sends with, and
    /// new work when nothing was picked: what the person's preferences start
    /// on over the computer's catalog (`ModelCatalog.startMode`).
    public func defaultMode(_ preferences: ModelPreferences) async throws -> AgentWire.Mode {
        try await modelCatalog().startMode(preferences)
    }

    /// The models every account offers, in the daemon's order.
    public func modelCatalog() async throws -> ModelCatalog {
        try await modelCatalogResponse().catalog
    }

    /// The catalog with the response it was read from, to keep offline.
    public func modelCatalogResponse() async throws -> (catalog: ModelCatalog, text: String) {
        let body = try await send("GET", "/v0/config").body
        guard let catalog = ModelCatalog(response: body) else { throw AgentClientError.invalidResponse }
        return (catalog, String(decoding: body, as: UTF8.self))
    }

    /// Each account's plan usage, by provider ID.
    public func accountUsage() async throws -> [String: AccountUsage] {
        AccountUsage.project(try await decode(JSONValue.self, "GET", "/v0/usage"))
    }

    /// `GET /v0/usage` as it came: each account's plan reading and the
    /// rolling token windows Settings › Usage reads (`UsageOverview`).
    public func usageResponse() async throws -> JSONValue {
        try await decode(JSONValue.self, "GET", "/v0/usage")
    }

    /// Whether the server keeps a daily history (`capabilities.dailyUsage`).
    public func servesDailyUsage() async throws -> Bool {
        try await decode(JSONValue.self, "GET", "/v0/health")["capabilities"]?["dailyUsage"]?.boolValue == true
    }

    /// `GET /v0/usage/daily`: the last `days` local days in `timeZone`
    /// (an IANA name) that spent tokens (`DailyUsage.read`).
    public func dailyUsage(days: Int, timeZone: String) async throws -> JSONValue {
        try await decode(JSONValue.self, "GET", "/v0/usage/daily?days=\(days)&tz=\(Self.escape(timeZone))")
    }

    /// Asks for fresher readings of these accounts; they arrive as
    /// `provider.usage.updated`.
    public func refreshAccountUsage(_ providerIds: [String]) async throws {
        _ = try await send("POST", "/v0/usage/refresh", json: .object(["providerIds": .array(providerIds.map { .string($0) })]))
    }

    /// The mode the agent's last message carried; nil before its first.
    public func agentMode(_ agentId: String) async throws -> AgentWire.Mode? {
        struct Response: Decodable { let mode: AgentWire.Mode? }
        return try await decode(Response.self, "GET", "/v0/agents/\(Self.escape(agentId))/mode").mode
    }

    /// Always steering, as desktop sends: mid-turn it is taken at the next
    /// boundary rather than waiting behind the run; idle, it starts one.
    /// `progress` hears each image's share written, in order, as the body goes out.
    public func sendMessage(_ agentId: String, id: String, text: String, images: [(mimeType: String, data: Data)], toolRequest: AgentWire.ToolCallRequest? = nil,
        mode: AgentWire.Mode, progress: (@Sendable ([Double]) -> Void)? = nil) async throws {
        guard images.allSatisfy({ $0.data.count <= AttachmentRules.maxInlineImageBytes }),
              images.reduce(0, { $0 + $1.data.count }) <= AttachmentRules.maxInlineImageTotalBytes else {
            throw AttachmentRules.invalid("Inline images exceed the model's image limit.")
        }
        let caption = text.isEmpty && !images.isEmpty ? (images.count == 1 ? "Attached image." : "Attached images.") : text
        var object: [String: JSONValue] = [
            "id": .string(id), "text": .string(caption), "delivery": .string("steer"),
            "clientMetadata": .object(["composer": .string("mobile")]),
        ]
        let encoded = images.map { $0.data.base64EncodedString() }
        if !images.isEmpty || toolRequest != nil {
            // /send prepends its required top-level text to these rich blocks.
            object["content"] = .array(zip(images, encoded).map {
                .object(["type": .string("image"), "mimeType": .string($0.0.mimeType), "data": .string($0.1)])
            } + (toolRequest.map { [$0.json] } ?? []))
        }
        object["mode"] = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(mode))
        // Only to a computer that takes it: an older one refuses the whole send.
        if let deviceId = environment.sendingDeviceId { object["deviceId"] = .string(deviceId) }
        let path = "/v0/agents/\(Self.escape(agentId))/send"
        // Pictures make it a file's size: a file's client and deadline.
        let category: RequestCategory = images.isEmpty ? .query : .file
        guard let progress, !images.isEmpty else {
            _ = try await send("POST", path, json: .object(object), category: category)
            return
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        let body = try encoder.encode(JSONValue.object(object))
        // Where each picture's base64 is in the body: the bytes written
        // so far say how far each one is.
        let ranges = UploadRanges(body: body, encoded: encoded)
        progress(ranges.shares(sent: 0))
        _ = try await send("POST", path, raw: body, category: category, sent: { progress(ranges.shares(sent: $0)) })
    }

    /// Runs one slash command on the module that offers it
    /// (`POST /v0/agents/:agentId/slash-commands/:name`), under the mode a
    /// message would go with. `arguments` only for one that takes them.
    /// The catalog as the computer has it after its refresh; what the
    /// command does comes as events. 404: no such command now; 409: it
    /// can't run in the agent's current state.
    public func invokeSlashCommand(_ agentId: String, name: String, arguments: String?, mode: AgentWire.Mode, mutationId: String) async throws -> [AgentWire.SlashCommand]? {
        var body: [String: JSONValue] = [
            "mode": try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(mode)),
            "mutationId": .string(mutationId),
        ]
        if let arguments { body["arguments"] = .string(arguments) }
        let answer = try await decode(JSONValue.self, "POST", "/v0/agents/\(Self.escape(agentId))/slash-commands/\(Self.escape(name))", json: .object(body))
        return AgentWire.SlashCommand.catalog(answer["slashCommands"])
    }

    /// The connection's global skills new work's `/` offers before it has
    /// an agent (`GET /v0/skills`, every page; a page cursor a change made
    /// stale starts the list again), as `SlashCommands.globalSkills` keeps
    /// them. Nil from a computer without skill management (404, 501).
    public func globalSkills() async throws -> [AgentWire.SlashCommand]? {
        var summaries: [JSONValue] = []
        var page: String?
        var restarts = 0
        while true {
            let answer: JSONValue
            do {
                answer = try await decode(JSONValue.self, "GET", "/v0/skills?limit=100" + (page.map { "&pageCursor=\(Self.escape($0))" } ?? ""))
            } catch AgentClientError.status(let status, _, _) where status == 404 || status == 501 {
                return nil
            } catch AgentClientError.status(409, _, _) where page != nil && restarts < 3 {
                summaries = []
                page = nil
                restarts += 1
                continue
            }
            summaries += answer["skills"]?.arrayValue ?? []
            guard let next = answer["nextPageCursor"]?.stringValue else { break }
            page = next
        }
        return SlashCommands.globalSkills(summaries)
    }

    /// The composer's draft as the computer keeps it for this person.
    public func draft(_ agentId: String) async throws -> AgentWire.Draft {
        struct Response: Decodable { var draft: AgentWire.Draft }
        return try await decode(Response.self, "GET", "/v0/agents/\(Self.escape(agentId))/draft").draft
    }

    /// Saves the draft, or clears it with nil. A write older than the one
    /// kept is ignored; the answer is what is kept either way.
    public func saveDraft(_ agentId: String, value: AgentWire.DraftValue?, updatedAt: Double, mutationId: String) async throws -> AgentWire.Draft {
        struct Response: Decodable { var draft: AgentWire.Draft }
        let draft: JSONValue = try value.map { try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode($0)) } ?? .null
        let body: JSONValue = .object(["draft": draft, "updatedAt": .number(updatedAt), "mutationId": .string(mutationId)])
        return try await decode(Response.self, "PUT", "/v0/agents/\(Self.escape(agentId))/draft", json: body).draft
    }

    public func abort(_ agentId: String) async throws {
        _ = try await send("POST", "/v0/agents/\(Self.escape(agentId))/abort", json: .object([:]))
    }

    /// A failed turn run again (`…/messages/:id/retry`), or moved to another
    /// model and continued there (`…/switch`): the failure's message, now
    /// carrying its resolution. The continued run comes as events.
    public func resolveFailure(_ agentId: String, messageId: String, switchTo mode: AgentWire.Mode?, mutationId: String) async throws -> AgentWire.Message {
        struct Response: Decodable { var message: AgentWire.Message }
        var body: [String: JSONValue] = ["mutationId": .string(mutationId)]
        if let mode {
            body["providerId"] = .string(mode.providerId)
            body["modelId"] = .string(mode.modelId)
        }
        let path = "/v0/agents/\(Self.escape(agentId))/messages/\(Self.escape(messageId))/\(mode == nil ? "retry" : "switch")"
        return try await decode(Response.self, "POST", path, json: .object(body)).message
    }

    /// The question the agent is waiting on, or nil when none is.
    public func question(_ agentId: String) async throws -> AgentWire.Question? {
        struct Response: Decodable { var question: AgentWire.Question? }
        return try await decode(Response.self, "GET", "/v0/agents/\(Self.escape(agentId))/question").question
    }

    /// Answers a question: each prompt's option labels or typed text, by
    /// its ID. The first answer wins; a late one is refused with the
    /// question as it now stands.
    public func answerQuestion(_ agentId: String, questionId: String, answers: [String: [String]], mutationId: String) async throws -> AgentWire.Question {
        struct Response: Decodable { var question: AgentWire.Question }
        let body: JSONValue = .object([
            "answers": .object(answers.mapValues { .array($0.map(JSONValue.string)) }),
            "mutationId": .string(mutationId),
        ])
        return try await decode(Response.self, "POST", "/v0/agents/\(Self.escape(agentId))/question/\(Self.escape(questionId))/answer", json: body).question
    }

    public func markRead(_ agentId: String) async throws {
        _ = try await send("POST", "/v0/agents/\(Self.escape(agentId))/read", json: .object([:]))
    }

    /// A media item's bytes, whole or one range of them.
    public func media(_ agentId: String, toolCallId: String, index: Int, range: ClosedRange<Int>? = nil) async throws -> HTTP1Response {
        let headers = range.map { ["Range": "bytes=\($0.lowerBound)-\($0.upperBound)"] } ?? [:]
        return try await send("GET", "/v0/agents/\(Self.escape(agentId))/tool-calls/\(Self.escape(toolCallId))/media/\(index)", headers: headers, category: .file)
    }

    // MARK: Sidebar proposals

    /// A proposal Prioritizing made, with its latest document.
    public func sidebarProposal(_ artifactId: String) async throws -> AgentWire.SidebarProposalResponse {
        try await decode(AgentWire.SidebarProposalResponse.self, "GET", "/v0/spaces/sidebar/proposals/\(Self.escape(artifactId))")
    }

    /// Takes the proposal as the person's own change of the sidebar.
    public func acceptSidebarProposal(_ artifactId: String, mutationId: String) async throws -> AgentWire.SidebarProposal {
        struct Answer: Decodable { let proposal: AgentWire.SidebarProposal }
        return try await decode(Answer.self, "POST", "/v0/spaces/sidebar/proposals/\(Self.escape(artifactId))/accept", json: .object(["mutationId": .string(mutationId)])).proposal
    }

    /// Keeps the sidebar as it is.
    public func declineSidebarProposal(_ artifactId: String, mutationId: String) async throws -> AgentWire.SidebarProposal {
        struct Answer: Decodable { let proposal: AgentWire.SidebarProposal }
        return try await decode(Answer.self, "POST", "/v0/spaces/sidebar/proposals/\(Self.escape(artifactId))/decline", json: .object(["mutationId": .string(mutationId)])).proposal
    }

    // MARK: Artifacts

    /// An artifact object, a deleted one's too (`GET /v0/artifacts/:artifactId`).
    public func artifact(_ artifactId: String) async throws -> JSONValue {
        guard let artifact = try await decode(JSONValue.self, "GET", "/v0/artifacts/\(Self.escape(artifactId))")["artifact"] else { throw AgentClientError.invalidResponse }
        return artifact
    }

    /// What the daemon serves every page beside its files: `api/v1/style.css`,
    /// `client.js` and the rest (`GET /v0/artifacts/:id/api/v1/*`). `path` is
    /// what follows `api/v1/`, escaped as the page wrote it.
    public func artifactAPI(_ artifactId: String, path: String) async throws -> HTTP1Response {
        try await send("GET", "/v0/artifacts/\(Self.escape(artifactId))/api/v1/\(path)", category: .file)
    }

    /// One version of an artifact, `nil` for the latest: its entry, its files
    /// and how it wants to be shown.
    public func artifactVersion(_ artifactId: String, version: Int?) async throws -> AgentWire.ArtifactVersion {
        struct Answer: Decodable { let version: AgentWire.ArtifactVersion }
        return try await decode(Answer.self, "GET", "/v0/artifacts/\(Self.escape(artifactId))/versions/\(version.map(String.init) ?? "latest")").version
    }

    /// One file of a numbered version, whole or one range of it. `path` is
    /// the manifest's, each segment escaped on its own. `range` is a `Range` header as a player sent it.
    public func artifactFile(_ artifactId: String, version: Int, path: String, range: String? = nil) async throws -> HTTP1Response {
        let headers = range.map { ["Range": $0] } ?? [:]
        let escaped = path.split(separator: "/", omittingEmptySubsequences: false).map { Self.escape(String($0)) }.joined(separator: "/")
        return try await send("GET", "/v0/artifacts/\(Self.escape(artifactId))/versions/\(version)/files/\(escaped)", headers: headers, category: .file)
    }

    /// One answer holds at most 8 MiB, so a whole file is read in ranges
    /// of this size.
    public static let rangeChunk = 4 * 1024 * 1024

    /// Reads a file a range at a time through `fetch` (nil: the whole file,
    /// for one that is empty). `each` takes the pieces in order, with the
    /// first answer's head on the first and the file's whole length.
    public static func read(
        isolation: isolated (any Actor)? = #isolation,
        _ fetch: (ClosedRange<Int>?) async throws -> HTTP1Response,
        each: (_ piece: Data, _ head: HTTP1Response?, _ total: Int) async throws -> Void
    ) async throws {
        var offset = 0
        var total = Int.max
        while offset < total {
            try Task.checkCancellation()
            let response: HTTP1Response
            do {
                response = try await fetch(offset...(offset + rangeChunk - 1))
            } catch AgentClientError.status(416, _, _) where offset == 0 {
                let whole = try await fetch(nil)
                return try await each(whole.body, whole, whole.body.count)
            }
            // A server that ignores ranges answers with the whole file.
            if response.status == 200, offset == 0 { return try await each(response.body, response, response.body.count) }
            guard response.status == 206, !response.body.isEmpty,
                  let length = length(contentRange: response.headers["content-range"]) else { throw AgentClientError.invalidResponse }
            if offset == 0 { total = length }
            try await each(response.body, offset == 0 ? response : nil, total)
            offset += response.body.count
        }
    }

    /// A single `Range` no longer than one answer may hold, as a server may
    /// answer: `bytes=0-` asks for the first piece, and a player asks on.
    /// Anything else (several ranges, a suffix) is left as it is.
    public static func bounded(range header: String) -> String {
        let spec = header.trimmingCharacters(in: .whitespaces)
        guard spec.hasPrefix("bytes="), !spec.contains(",") else { return header }
        let bounds = spec.dropFirst(6).split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        guard bounds.count == 2, let start = Int(bounds[0].trimmingCharacters(in: .whitespaces)) else { return header }
        let last = start + rangeChunk - 1
        let end = Int(bounds[1].trimmingCharacters(in: .whitespaces)).map { min($0, last) } ?? last
        return "bytes=\(start)-\(end)"
    }

    /// The whole length in a `Content-Range` such as `bytes 0-1/28560`.
    public static func length(contentRange: String?) -> Int? {
        contentRange?.split(separator: "/").last.flatMap { Int($0) }
    }

    /// A daemon-relative image such as a bot's avatar.
    public func image(_ path: String) async throws -> Data {
        guard path.hasPrefix("/v0/") else { throw AgentClientError.invalidResponse }
        return try await send("GET", path, category: .file).body
    }

    // MARK: Events

    /// The journal as it happens, from `after` when given. The first frame is
    /// `hello`; the stream ends when the connection does, or when nothing,
    /// not even a heartbeat, has come for `silence`.
    public func events(after cursor: String?) async throws -> AsyncThrowingStream<ServerSentEvent, Error> {
        var headers: [String: String] = [:]
        if let cursor { headers["Last-Event-ID"] = cursor }
        let response = try await transport.stream(path: "/v0/events/stream", credential: token, headers: headers)
        if response.status == 401 { throw AgentClientError.revoked }
        guard response.status == 200 else { throw AgentClientError.status(response.status, code: nil, message: nil) }
        let body = response.body
        let transport = transport
        return AsyncThrowingStream { continuation in
            let reader = Task {
                var parser = ServerSentEventParser()
                let heard = Heard()
                let watchdog = Self.watch(continuation, transport: transport, heard: heard)
                defer { watchdog.cancel() }
                do {
                    for try await bytes in body {
                        heard.now()
                        RadioWake.shared.noted()
                        for frame in parser.append(bytes) { continuation.yield(frame) }
                    }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in reader.cancel() }
        }
    }

    /// The daemon writes a heartbeat every 15 seconds. A computer whose
    /// daemon restarted or went to sleep never closes the tunnel's stream,
    /// so this long without a byte means it is gone, and so is the tunnel.
    static let silence: Duration = .seconds(40)

    /// When the stream last brought bytes.
    private final class Heard: @unchecked Sendable {
        private let lock = NSLock()
        private var last = ContinuousClock.now
        func now() { lock.withLock { last = .now } }
        var lastHeard: ContinuousClock.Instant { lock.withLock { last } }
    }

    /// One sleeper for the stream's life, woken at the silence deadline and
    /// put back to sleep if bytes came meanwhile: not a task made and
    /// cancelled for every chunk.
    private static func watch(_ continuation: AsyncThrowingStream<ServerSentEvent, Error>.Continuation, transport: any AgentTransport, heard: Heard) -> Task<Void, Never> {
        Task {
            while true {
                let due = heard.lastHeard + silence
                guard (try? await Task.sleep(until: due, clock: .continuous)) != nil else { return }
                if ContinuousClock.now >= heard.lastHeard + silence { break }
            }
            await transport.reset(.realtime)
            continuation.finish(throwing: PairingError.unavailable)
        }
    }

    static func escape(_ component: String) -> String {
        component.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? component
    }
}

/// The task, workspace and conversation a client names for a new task.
public struct Identity: Equatable, Sendable {
    public let taskId: String
    public let workspaceId: String
    public let agentId: String

    public static func make() -> Identity {
        Identity(taskId: ClientID.make(), workspaceId: ClientID.make(), agentId: ClientID.make())
    }
}

extension AgentConnections {
    /// A client for a paired device, sharing nothing with its identity refresh.
    public func agentClient(for accountID: String) -> AgentClient? {
        guard let credential = credential(for: accountID) else { return nil }
        return AgentClient(transport: transport(credential, for: accountID), token: credential.deviceToken, signsIn: credential.signIn != nil)
    }
}
