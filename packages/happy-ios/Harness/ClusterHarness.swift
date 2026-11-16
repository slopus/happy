#if canImport(UIKit) && (DEBUG || HAPPY_FIXTURES)
import Foundation
@testable import HappyCore
@testable import HappyUI
import HappyWire
import UIKit

private struct ClusterOffline: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

/// Happy's push relay, answering every registration with one token.
private struct ClusterRelay: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        HTTPResponse(status: 200, body: Data(#"{"token":"HappyPushToken[3MTQ1KZhQAh5CdD4rY7xRX]"}"#.utf8))
    }
}

/// The notification permission as `-push granted|denied` has it; asked
/// while undetermined (the default), it is granted.
private actor ClusterPermission {
    var system: PushPermission.SystemStatus
    init(_ system: PushPermission.SystemStatus) { self.system = system }
    func current() -> PushPermission { PushPermission(system: system) }
    func request() -> PushPermission {
        if system == .notDetermined { system = .authorized }
        return current()
    }
}

private struct ClusterNoSocket: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// A Happy Cloud server as happy-cluster answers its plugin routes
/// (API.md, "Plugins"), for screenshots before the routes are deployed:
/// GitHub (an App sign-in and a token), Linear (no sign-in) and Sentry
/// (a key) offered; GitHub installed twice, once signed in. Writes change
/// what it lists, as the server's do. `manager: false` refuses the
/// installations, as the server does a member without `mcp.manage`.
actor ClusterServer: AgentTransport {
    static let bootstrap = #"""
    {"cursor":"cursor-1","profile":{"userId":"steve","name":"Steve","photo":null},"userSettings":[],
     "projects":[],"workspaces":[],
     "bots":[{"id":"cos","name":"Chief of Staff","systemKey":"chief_of_staff","status":"active","agent":{"id":"cos-agent","workspaceId":"cos-w","status":"idle"}}],
     "tasks":[{"id":"t1","name":"Plan the launch","ownerUserId":"steve","status":"active","agent":{"id":"t1-agent","workspaceId":"w1","status":"idle"}}],
     "taskMemberships":[{"taskId":"t1"}],"surfaces":[]}
    """#

    static let catalog = #"""
    {"plugins":[
      {"id":"github","name":"GitHub","description":"Repositories, issues and pull requests, for agents to read and act on.","version":"1.0.0",
       "image":{"digest":"github","mime":"image/png","thumbhash":null},
       "tools":[{"name":"list_repositories","summary":"Lists the repositories the installation can reach."},
                {"name":"get_issue","summary":"Reads one issue with its comments."},
                {"name":"create_pull_request","summary":"Opens a pull request from a branch."}],
       "auth":{"required":true,"methods":[
         {"id":"install","label":"GitHub App","type":"oauth","scopes":["contents:read","metadata:read"]},
         {"id":"token","label":"Access token","type":"fields","fields":[
           {"key":"token","label":"Personal access token","help":"Make one at github.com/settings/tokens with repo access.","required":true,"secret":true,"multiline":false}]}]}},
      {"id":"linear","name":"Linear","description":"Issues, projects and cycles.","version":"0.4.2",
       "image":{"digest":"linear","mime":"image/png","thumbhash":null},
       "tools":[{"name":"search_issues","summary":"Finds issues by text."}],"auth":{"required":false,"methods":[]}},
      {"id":"sentry","name":"Sentry","description":"Errors and performance from production.","version":"2.1.0",
       "image":{"digest":"sentry","mime":"image/png","thumbhash":null},
       "tools":[{"name":"list_issues","summary":"Lists unresolved issues."}],
       "auth":{"required":true,"methods":[
         {"id":"key","label":"Auth token","type":"fields","fields":[
           {"key":"token","label":"Auth token","help":"From Settings › Auth Tokens.","required":true,"secret":true,"multiline":false},
           {"key":"org","label":"Organization slug","help":"","required":true,"secret":false,"multiline":false}]}]}}
    ]}
    """#

    struct Installation {
        var id: String
        var plugin: String
        var ordinal: Int
        var label: String?
        var status: String
        var authMethod: String?

        var json: String {
            let name = ["github": "GitHub", "linear": "Linear", "sentry": "Sentry"][plugin] ?? plugin
            let prefix = ordinal > 1 ? "plugin_\(plugin)_\(ordinal)_" : "plugin_\(plugin)_"
            func quoted(_ text: String?) -> String { text.map { "\"\($0)\"" } ?? "null" }
            return #"{"id":"\#(id)","plugin":"\#(plugin)","pluginName":"\#(name)","ordinal":\#(ordinal),"label":\#(quoted(label)),"status":"\#(status)","reason":null,"authMethod":\#(quoted(authMethod)),"toolPrefix":"\#(prefix)","image":{"digest":"\#(plugin)","mime":"image/png","thumbhash":null},"available":true}"#
        }
    }

    let manager: Bool
    private(set) var installations: [Installation] = [
        .init(id: "i1", plugin: "github", ordinal: 1, label: nil, status: "active", authMethod: "token"),
        .init(id: "i2", plugin: "github", ordinal: 2, label: "Acme", status: "not_configured", authMethod: nil),
    ]
    private var next = 3
    /// The team's own provider, once one is put.
    private var custom: String?

    /// Onboarding as the deployed server sends it, without gates, for a
    /// member yet to give their name (`-nameless`).
    let nameless: Bool
    /// Health says it serves plugins; off (`-noplugins`), as deployed before them.
    let servesPlugins: Bool
    /// Health says it runs pipelines; off (`-nopipelines`), as deployed before them.
    let servesPipelines: Bool
    /// The events stream opens, the running migration logs a line a
    /// second, and ten seconds on the pipelines move on (`-livepipelines`);
    /// otherwise the stream can't be reached.
    let livePipelines: Bool
    private var pipelines = ClusterPipelines()
    private var streams: [AsyncThrowingStream<Data, Error>.Continuation] = []
    private var cursor = 1
    /// An existing tenant while the move to the settings rolls out
    /// (`-policyvault`): its Policy vault still flagged, beside the config
    /// routes and `policy.edit`.
    let policyVault: Bool
    /// As deployed before the move (`-production`): the flagged Policy
    /// vault only, no config routes, no `policy.edit` in the catalog.
    let production: Bool
    /// How invites go (`-invites`): by email; `noemail`, links only; `none`, no route.
    let invites: String?
    private var instructions = "# Acme\n\nWe build developer tools. Write tests with every change, and keep pull requests small.\n\n## Style\n\n- Swift: UIKit, no storyboards.\n- Prefer plain words in docs.\n"
    private var security = "Never send secrets to a model. Ask before running anything that touches production.\n"

    static func document(_ key: String, _ text: String) -> String {
        String(data: try! JSONEncoder().encode([key: text]), encoding: .utf8)!
    }

    /// Onboarding's gates (`-gates`), in order; nil: the route answers
    /// completed with none.
    private var gates: [Gate]?
    private var profileName: String?
    private var botName = "Chief of Staff"
    private var botVersion = 1

    /// One gate: `id[:required|optional][:open|done|unavailable|theirs]`,
    /// `theirs` being one the person's role can't complete.
    struct Gate {
        var id: String
        var required: Bool
        var done: Bool?
        var skipped = false
        var canComplete: Bool

        init(_ spec: Substring) {
            let parts = spec.split(separator: ":").map(String.init)
            id = parts[0]
            required = parts.contains("required")
            done = parts.contains("done") ? true : parts.contains("unavailable") ? nil : false
            canComplete = !parts.contains("theirs")
        }

        var status: String { done == true ? "done" : skipped && !required ? "skipped" : done == nil ? "unavailable" : "open" }
        var blocking: Bool { required && (status == "open" || status == "unavailable") }
        var pending: Bool { blocking || (!required && status == "open" && canComplete) }
        var scope: String { ["profile", "avatar", "mobileApp"].contains(id) ? "member" : "server" }
    }

    init(manager: Bool = true, installed: Bool = true, nameless: Bool = false, gates: String? = nil, servesPlugins: Bool = true, servesPipelines: Bool = true, livePipelines: Bool = false,
         refusesAbort: Bool = false, policyVault: Bool = false, production: Bool = false, invites: String? = nil) {
        self.manager = manager
        self.servesPipelines = servesPipelines
        self.livePipelines = livePipelines
        pipelines.refusesAbort = refusesAbort
        self.invites = invites
        self.servesPlugins = servesPlugins
        self.policyVault = policyVault
        self.production = production
        self.nameless = nameless
        if !installed { installations = [] }
        self.gates = gates?.split(separator: ",").map(Gate.init)
        if !nameless, self.gates?.contains(where: { $0.id == "profile" && $0.done == true }) != false { profileName = "Steve" }
    }

    private func mark(_ id: String) {
        guard let index = gates?.firstIndex(where: { $0.id == id }) else { return }
        gates?[index].done = true
    }

    /// The plugins gate's one needed plugin, as the server reads it.
    private var githubActive: Bool { installations.contains { $0.plugin == "github" && $0.status == "active" } }

    private var onboarding: String {
        if githubActive { mark("plugins") }
        let gates = gates ?? []
        func data(_ gate: Gate) -> String {
            switch gate.id {
            case "adminBot":
                return #"{"botId":"cos","agentId":"cos-agent","name":"\#(botName)","version":"v\#(botVersion)","avatar":null,"title":"Name your admin bot","description":"This is your server’s admin bot. It can change the server’s settings, connect tools and create other bots, so it can adapt Happy and build a system around how your team works.","points":["Changes the server’s settings","Connects tools and plugins","Creates bots for your team"],"note":"Only owners can talk to it."}"#
            case "inference": return #"{"connected":[],"freeModel":true}"#
            case "plugins": return #"{"required":["github"],"plugins":[{"id":"github","name":"GitHub","required":true,"active":\#(githubActive)}]}"#
            case "teammates": return #"{"invited":false,"members":1}"#
            case "mobileApp": return #"{"registered":false,"appStoreUrl":"https://apps.apple.com/us/app/happy-claude-code-client/id6748571505","playStoreUrl":"https://play.google.com/store/apps/details?id=com.ex3ndr.happy"}"#
            default: return "{}"
            }
        }
        let views = gates.map { gate in
            #"{"id":"\#(gate.id)","scope":"\#(gate.scope)","requirement":"\#(gate.required ? "required" : "optional")","status":"\#(gate.status)","blocking":\#(gate.blocking),"canComplete":\#(gate.canComplete),"data":\#(data(gate))}"#
        }
        let blocking = gates.filter(\.blocking).map { "\"\($0.id)\"" }
        return #"{"finished":\#(!gates.contains(where: \.pending)),"completed":true,"owners":[{"userId":"olga","name":"Olga"}],"blocking":[\#(blocking.joined(separator: ","))],"gates":[\#(views.joined(separator: ","))]}"#
    }

    private var profile: String {
        #"{"profile":{"email":null,"name":\#(profileName.map { "\"\($0)\"" } ?? "null"),"photo":null,"userId":"steve","updatedAt":0,"version":"v1"}}"#
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        func ok(_ text: String, status: Int = 200) -> HTTP1Response { HTTP1Response(status: status, headers: ["content-type": "application/json"], body: Data(text.utf8)) }
        func refuse(_ status: Int, _ code: String, _ error: String) -> HTTP1Response { ok(#"{"code":"\#(code)","error":"\#(error)"}"#, status: status) }
        let sent = body.flatMap { try? JSONValue.decode($0) }
        let installation = path.hasPrefix("/v0/plugins/installations/") ? path.dropFirst("/v0/plugins/installations/".count).split(separator: "/").map(String.init) : []
        if servesPipelines, let answer = pipelines.answer(method, path) {
            publish(answer.events)
            return ok(answer.body, status: answer.status)
        }
        if let answer = ClusterChat.answer(method, path) { return ok(answer) }
        switch (method, path) {
        case ("GET", "/v0/bootstrap/desktop"): return ok(Self.bootstrap)
        case ("GET", "/v0/health"):
            let served = ["\"vaults\":true"] + (servesPlugins ? ["\"plugins\":true"] : []) + (servesPipelines ? ["\"pipelines\":true"] : [])
            return ok(#"{"ready":true,"capabilities":{\#(served.joined(separator: ","))}}"#)
        case ("GET", "/v0/onboarding") where nameless:
            return ok(#"{"completed":false,"steps":{"profile":{"done":true},"chiefOfStaff":{"done":false}},"member":{"completed":false,"steps":{"profile":{"done":\#(profileName != nil)}}}}"#)
        case ("GET", "/v0/onboarding"): return ok(onboarding)
        case ("POST", "/v0/onboarding/complete"):
            if let blocking = gates?.filter(\.blocking).map(\.id), !blocking.isEmpty {
                return ok(#"{"code":"onboarding_incomplete","error":"Finish onboarding first.","blocking":["\#(blocking.joined(separator: "\",\""))"]}"#, status: 409)
            }
            for index in gates?.indices ?? 0..<0 where gates?[index].pending == true { gates?[index].skipped = true }
            return ok(#"{"completed":true}"#)
        case ("POST", let path) where path.hasPrefix("/v0/onboarding/gates/") && path.hasSuffix("/skip"):
            let id = path.dropFirst("/v0/onboarding/gates/".count).dropLast("/skip".count)
            guard let index = gates?.firstIndex(where: { $0.id == id }) else { return refuse(404, "not_found", "No such gate.") }
            guard gates?[index].required == false else { return refuse(409, "gate_required", "This step is required.") }
            gates?[index].skipped = true
            return ok(onboarding)
        case ("GET", "/v0/bots/cos"):
            return ok(#"{"bot":{"id":"cos","name":"\#(botName)","version":"v\#(botVersion)","systemKey":"chief_of_staff"}}"#)
        case ("PATCH", "/v0/bots/cos"):
            guard headers["If-Match"] == "v\(botVersion)" else { return refuse(409, "version_conflict", "The bot changed.") }
            botName = sent?["name"]?.stringValue ?? botName
            botVersion += 1
            mark("adminBot")
            return ok(#"{"bot":{"id":"cos","name":"\#(botName)","version":"v\#(botVersion)"}}"#)
        case ("GET", "/v0/profile"): return ok(profile)
        case ("PATCH", "/v0/profile"):
            profileName = sent?["name"]?.stringValue
            mark("profile")
            return ok(profile)
        case ("PUT", "/v0/profile/photo"):
            mark("avatar")
            return ok(profile)
        case ("GET", "/v0/permissions"):
            let catalog = (["content.write", "bots.manage", "mcp.manage", "config.manage", "providers.manage", "providers.own"] + (production ? [] : ["policy.edit"]))
                .map { #"{"id":"\#($0)","description":""}"# }.joined(separator: ",")
            let granted = manager ? #""content.write","bots.manage","mcp.manage","config.manage","providers.manage","providers.own"\#(production ? "" : #","policy.edit""#)"# : #""content.write","providers.own""#
            return ok(#"{"role":"\#(manager ? "owner" : "member")","granted":[\#(granted)],"permissions":[\#(catalog)]}"#)
        case ("GET", "/v0/surfaces"):
            // A Files vault; beside it the flagged Policy vault while it is
            // kept (`-policyvault`) and as deployed before (`-production`).
            let policy = policyVault || production ? #",{"id":"policy","type":"vault","name":"Policy","access":"read","policyVault":true}"# : ""
            return ok(#"{"surfaces":[{"id":"files","type":"vault","name":"Files","access":"write","defaultVault":true}\#(policy)]}"#)
        case ("GET", "/v0/config/instructions") where !production: return ok(Self.document("instructions", instructions))
        case ("GET", "/v0/config/security") where !production: return ok(Self.document("policy", security))
        case ("PUT", "/v0/config/instructions") where !production, ("PUT", "/v0/config/security") where !production:
            guard manager else { return refuse(403, "forbidden", "This needs the policy.edit permission.") }
            let key = path.hasSuffix("instructions") ? "instructions" : "policy"
            let text = sent?[key]?.stringValue ?? ""
            if key == "instructions" { instructions = text } else { security = text }
            return ok(Self.document(key, text))
        case ("GET", "/v0/cloud/providers"):
            let own = custom.map { #",{"id":"\#($0)","name":"\#($0)","scope":"team","source":"tenant","vendors":["openai_compatible"],"models":[],"credentialCount":1}"# } ?? ""
            return ok(#"{"providers":[{"id":"operator:openai","name":"Happy (free)","scope":"team","source":"operator","vendors":["openai"],"models":[],"credentialCount":0}\#(own)],"capabilities":{"apiKeys":true,"claudeSetupToken":true,"codexSignIn":true,"claudeSignIn":false}}"#)
        case ("PUT", let path) where path.hasPrefix("/v0/providers/"):
            guard sent?["baseUrl"]?.stringValue?.hasPrefix("https://") == true else { return refuse(400, "invalid", "`baseUrl` must be an https URL.") }
            custom = String(path.dropFirst("/v0/providers/".count))
            mark("inference")
            return ok(#"{"providerId":"\#(custom ?? "")","credentials":"available"}"#)
        case ("POST", let path) where path.hasPrefix("/v0/cloud/providers/") && path.hasSuffix("/credentials"):
            mark("inference")
            return ok(#"{"credential":{"id":"k1"}}"#, status: 201)
        case ("POST", "/v0/invites"):
            // `-invites noemail`: email isn't set up; `none`: no route, as before invites.
            if invites == "none" { break }
            let email = sent?["email"]?.stringValue
            if email != nil, invites == "noemail" { return refuse(503, "email_not_configured", "This server can’t send email.") }
            next += 1
            mark("teammates")
            let delivery = email.map { #","deliveryStatus":"\#($0.hasPrefix("fail") ? "failed" : "sent")""# } ?? ""
            return ok(#"{"invite":{"id":"inv\#(next)","link":"https://acme.happy.engineering/join#inv\#(next)","expiresAt":"2026-11-20T00:00:00Z","role":"member"\#(delivery)}}"#, status: 201)
        case ("PUT", let path) where path.hasPrefix("/v0/cloud/push/registrations/"):
            guard sent?["token"]?.stringValue?.hasPrefix("HappyPushToken[") == true, sent?["platform"]?.stringValue == "ios" else { return refuse(400, "invalid", "Invalid push registration.") }
            mark("mobileApp")
            return ok(#"{"registration":{"id":"\#(path.dropFirst("/v0/cloud/push/registrations/".count))","version":"7c1d8a5e-2f43-4c1b-9d0e-1f2a3b4c5d6e","expiresAt":1900000000000}}"#)
        case ("GET", "/v0/plugins"): return ok(Self.catalog)
        case ("GET", "/v0/plugins/installations"):
            // Every member reads them; as deployed before, only managers.
            guard manager || !production else { return refuse(403, "forbidden", "This needs the mcp.manage permission.") }
            return ok(#"{"installations":[\#(installations.map(\.json).joined(separator: ","))],"canManage":\#(manager)}"#)
        case ("POST", "/v0/plugins/installations"):
            guard manager else { return refuse(403, "forbidden", "This needs the mcp.manage permission.") }
            let plugin = sent?["plugin"]?.stringValue ?? ""
            let ordinal = (installations.filter { $0.plugin == plugin }.map(\.ordinal).max() ?? 0) + 1
            let made = Installation(id: "i\(next)", plugin: plugin, ordinal: ordinal, label: nil, status: plugin == "linear" ? "active" : "not_configured", authMethod: nil)
            next += 1
            installations.append(made)
            return ok(#"{"installation":\#(made.json)}"#, status: 201)
        default:
            break
        }
        if let id = installation.first, let index = installations.firstIndex(where: { $0.id == id }) {
            switch (method, installation.dropFirst().first) {
            case ("DELETE", nil):
                installations.remove(at: index)
                return ok(#"{"deleted":true,"secretsDeleted":1,"cleanedUpOutside":true}"#)
            case ("POST", "configure"):
                let values = sent?["values"]?.objectValue ?? [:]
                if values["token"]?.stringValue?.hasPrefix("bad") == true {
                    return ok(#"{"code":"invalid_fields","error":"Some fields were refused.","fields":{"token":"GitHub didn’t accept this token. Check that it hasn’t expired."}}"#, status: 422)
                }
                installations[index].status = "active"
                installations[index].authMethod = sent?["method"]?.stringValue
                return ok(#"{"installation":\#(installations[index].json)}"#)
            case ("POST", "connect"):
                return ok(#"{"authorizeUrl":"https://github.com/apps/happy-engineering/installations/new?state=harness"}"#)
            case ("POST", "disconnect"):
                installations[index].status = "not_configured"
                installations[index].authMethod = nil
                return ok(#"{"installation":\#(installations[index].json),"removed":["s1"]}"#)
            default:
                break
            }
        }
        if path.hasPrefix("/v0/plugins/images/"), let picture = Self.mark(String(path.dropFirst("/v0/plugins/images/".count))) {
            return HTTP1Response(status: 200, headers: ["content-type": "image/png"], body: picture)
        }
        return refuse(404, "not_found", "Not here.")
    }

    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        guard livePipelines else { throw URLError(.notConnectedToInternet) }
        let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        streams.append(continuation)
        continuation.yield(Data("event: hello\ndata: {\"cursor\":\"cursor-1\",\"resumed\":true}\n\n".utf8))
        if streams.count == 1 {
            Task {
                for _ in 0..<8 {
                    try? await Task.sleep(for: .seconds(1))
                    self.publish(self.pipelines.tick())
                }
                try? await Task.sleep(for: .seconds(2))
                self.advancePipelines()
            }
        }
        return HTTP1Stream(status: 200, body: body)
    }

    /// The pipelines move on, and the stream says which runs changed.
    private func advancePipelines() {
        pipelines.advance()
        publish(["r12", "r1", "r2", "r3"].map { run in
            let pipeline = ["r12": "triage", "r1": "deploy", "r2": "build", "r3": "sweep"][run] ?? ""
            return ("pipeline.run.updated", #"{"pipelineId":"\#(pipeline)","runId":"\#(run)"}"#)
        } + [("pipeline.node.log", #"{"runId":"r1","nodeId":"migrate"}"#), ("pipeline.updated", #"{"pipelineId":"deploy"}"#)])
    }

    /// Journals `events` on every open stream.
    private func publish(_ events: [(type: String, payload: String)]) {
        for (type, payload) in events {
            cursor += 1
            let event = #"{"cursor":"cursor-\#(cursor)","type":"\#(type)","occurredAt":\#(Int64(Date().timeIntervalSince1970 * 1000)),"payload":\#(payload)}"#
            for stream in streams { stream.yield(Data("event: \(type)\ndata: \(event)\n\n".utf8)) }
        }
    }
    func reset() async {}
    func close() async {}

    /// Each plugin's mark: its letter on its colour.
    private static func mark(_ digest: String) -> Data? {
        let marks: [String: (UIColor, String)] = [
            "github": (UIColor(red: 0.09, green: 0.1, blue: 0.12, alpha: 1), "G"),
            "linear": (UIColor(red: 0.37, green: 0.42, blue: 0.82, alpha: 1), "L"),
            "sentry": (UIColor(red: 0.21, green: 0.16, blue: 0.29, alpha: 1), "S"),
        ]
        guard let (color, letter) = marks[digest] else { return nil }
        let side: CGFloat = 120
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).pngData { _ in
            color.setFill()
            UIRectFill(CGRect(x: 0, y: 0, width: side, height: side))
            let text = NSAttributedString(string: letter, attributes: [.font: UIFont.systemFont(ofSize: 64, weight: .bold), .foregroundColor: UIColor.white])
            let size = text.size()
            text.draw(at: CGPoint(x: (side - size.width) / 2, y: (side - size.height) / 2))
        }
    }
}

/// A Happy Cloud server's home over `ClusterServer`
/// (`-screen cluster`), opened on its plugins (`-open plugins`) or one
/// plugin (`-open plugin:github`), as a member who can't manage them
/// (`-member`) or with nothing installed (`-fresh`), in dark (`-dark`);
/// a member yet to give their name on a server without gates (`-nameless`);
/// onboarding's gates as `-gates profile:required,avatar,…` (`ClusterServer.Gate`);
/// a server that doesn't serve plugins (`-noplugins`); its pipelines
/// (`-open pipelines`, `ClusterPipelines`; `-bottom` scrolls to its last run, `-select <row>` taps a row), moving on over the events
/// stream (`-livepipelines`), or a server without them (`-nopipelines`);
/// a run (`-open run:r1`, from its row in the list with `-viarow`; `-scroll <row>` to a row, `-abort` asks to
/// abort it, `-aborted` aborts it as the confirmation does, refused with
/// `-abortrefused`) or one node of it (`-open node:r1:migrate`; `-toggle
/// <seq>` opens or folds a command, `-bottom` to the log's tail); on
/// either `-select <row>` taps a row; a pipeline (`-open pipeline:deploy`,
/// a version of it `pipeline:deploy:v7`, a node of its head
/// `pipeline:deploy:migrate`; `-scroll <row>`, `-bottom`, `-select <row>`);
/// Chief of Staff's chat with what it was told by no person (`-open chat`,
/// `ClusterChat`; `-earlier` its first turns alone, `-toggle <message>` opens one, `-tap <run>` a result's run);
/// an existing tenant
/// whose Policy vault is still flagged (`-policyvault`), or as deployed
/// before the documents moved to settings (`-production`);
/// `-open instructions|security|settings`; notifications `-push granted|denied`
/// (asked while unset), from a build the relay refuses (`-otherbuild`).
@MainActor
final class ClusterHarness {
    private var account: AccountController?

    init(window: HarnessWindow, arguments: [String]) {
        Task { await open(window: window, arguments: arguments) }
    }

    private func open(window: HarnessWindow, arguments: [String]) async {
        let server = ClusterServer(manager: !arguments.contains("-member"), installed: !arguments.contains("-fresh"), nameless: arguments.contains("-nameless"),
                                   gates: arguments.firstIndex(of: "-gates").flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil },
                                   servesPlugins: !arguments.contains("-noplugins"), servesPipelines: !arguments.contains("-nopipelines"),
                                   livePipelines: arguments.contains("-livepipelines"), refusesAbort: arguments.contains("-abortrefused"), policyVault: arguments.contains("-policyvault"),
                                   production: arguments.contains("-production"), invites: value("-invites", in: arguments))
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/cluster",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentConnectionCredentialStore: InMemoryAgentConnectionCredentialStore(), agentTransport: { _ in server },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) }, transport: ClusterOffline(), connector: ClusterNoSocket()
        )
        self.account = account
        let permission = ClusterPermission(["granted": .authorized, "denied": .denied][value("-push", in: arguments) ?? ""] ?? .notDetermined)
        SettingsHooks.cloudPush = CloudPush(source: .init(
            device: CloudPushDevice(appId: arguments.contains("-otherbuild") ? "com.slopus.happy.chat-harness" : "com.slopus.happy.dev", development: true),
            ids: CloudPushIDs(store: InMemoryKeyValueStore()), transport: ClusterRelay(),
            permission: { await permission.current() }, requestPermission: { await permission.request() },
            apnsToken: { Data([0xab, 0xcd, 0xef]) }
        ))
        do {
            let origin = HappyCloud.server(named: "acme")
            let connection = try await account.agentConnections.addServer(AgentOrigin(origin),
                signIn: ServerSignInRecord(method: HappyCloud.method(server: origin), grant: OAuthGrant(clientId: "harness"), userId: "steve"),
                access: OAuthAccess(token: "harness", expiresAt: nil), name: "Acme")
            let context = AppContext(account: account, variant: .development, version: "cluster")
            guard let session = Session.session(for: connection.id, context: context) else { return }
            let home = AgentHomeViewController(context: context, id: connection.id)
            let navigation = UINavigationController(rootViewController: home)
            AppCoordinator.applyAppearance(to: navigation.navigationBar)
            window.rootViewController = navigation
            if arguments.contains("-dark") { window.overrideUserInterfaceStyle = .dark }
            window.layoutIfNeeded()
            let open = arguments.firstIndex(of: "-open").flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil }
            try? await Task.sleep(for: .seconds(1))
            if let steps = value("-steps", in: arguments) { await walk(steps, home: home, window: window, arguments: arguments) }
            switch open {
            case "plugins":
                navigation.pushViewController(PluginsViewController(session: session), animated: false)
            case "pipelines":
                let pipelines = PipelinesViewController(session: session)
                navigation.pushViewController(pipelines, animated: false)
                // `-bottom`: to the last run, which reads the next page, then to its end.
                if arguments.contains("-bottom") {
                    for id in ["run:r8", "run:r11"] {
                        try? await Task.sleep(for: .seconds(2))
                        pipelines.list.scroll(to: id, animated: false)
                    }
                }
                // `-select <row>`: as a tap on that row.
                if let row = value("-select", in: arguments) {
                    try? await Task.sleep(for: .seconds(2))
                    pipelines.list.onSelect?(row)
                }
            case "chat":
                // Chief of Staff's conversation; `-toggle <message>` opens one, `-tap <run>` opens a result's run.
                let chat = ChatViewController(session: session, agentId: ClusterChat.agentId, title: "Chief of Staff", spaceId: nil, intro: nil)
                navigation.pushViewController(chat, animated: false)
                try? await Task.sleep(for: .seconds(1.5))
                if let id = value("-toggle", in: arguments) { chat.act(.toggleTool(id)) }
                if let run = value("-tap", in: arguments) { chat.act(.openPipelineRun(runId: run, pipelineName: nil)) }
            case let open? where open.hasPrefix("pipeline:"):
                // `pipeline:deploy`, `pipeline:deploy:v7` (a version), `pipeline:deploy:migrate` (a node of the head).
                let parts = open.split(separator: ":").map(String.init)
                navigation.pushViewController(PipelinesViewController(session: session), animated: false)
                var page = PipelineViewController(session: session, pipelineId: parts[1])
                navigation.pushViewController(page, animated: false)
                try? await Task.sleep(for: .seconds(1.5))
                if parts.count == 3 {
                    page.open(parts[2].hasPrefix("v") ? .version(Int(parts[2].dropFirst()) ?? 1) : .definitionNode(version: nil, nodeId: parts[2]))
                    page = navigation.topViewController as? PipelineViewController ?? page
                    try? await Task.sleep(for: .seconds(1.5))
                }
                // A scroll made here says nothing to the page, as a reader's does: it's told, so it reads the next page of runs.
                if let row = value("-scroll", in: arguments) {
                    page.list.scroll(to: row, animated: false)
                    page.list.onScroll?()
                }
                if arguments.contains("-bottom") {
                    for _ in 0..<2 {
                        page.list.list.scrollToBottom(animated: false)
                        page.list.onScroll?()
                        try? await Task.sleep(for: .seconds(1.5))
                    }
                    page.list.list.scrollToBottom(animated: false)
                }
                if let row = value("-select", in: arguments) { page.list.onSelect?(row) }
            case let open? where open.hasPrefix("run:") || open.hasPrefix("node:"):
                let parts = open.split(separator: ":").map(String.init)
                let list = PipelinesViewController(session: session)
                navigation.pushViewController(list, animated: false)
                let run: PipelineRunViewController
                if arguments.contains("-viarow") {
                    // As a tap on its row in the list, which knows its pipeline's name.
                    try? await Task.sleep(for: .seconds(1.5))
                    list.list.onSelect?(PipelineListItems.runId(parts[1]))
                    try? await Task.sleep(for: .seconds(0.5))
                    guard let shown = navigation.topViewController as? PipelineRunViewController else { break }
                    run = shown
                } else {
                    run = PipelineRunViewController(session: session, runId: parts[1])
                    navigation.pushViewController(run, animated: false)
                }
                if parts.count == 3 {
                    let node = PipelineNodeViewController(session: session, run: run.feed, nodeId: parts[2])
                    navigation.pushViewController(node, animated: false)
                    try? await Task.sleep(for: .seconds(1.5))
                    if let seq = value("-toggle", in: arguments).flatMap(Int.init) { node.open(.command(seq: seq)) }
                    if arguments.contains("-bottom") {
                        try? await Task.sleep(for: .seconds(0.5))
                        node.list.list.scrollToBottom(animated: false)
                    }
                    if let row = value("-select", in: arguments) { node.list.onSelect?(row) }
                } else {
                    try? await Task.sleep(for: .seconds(1.5))
                    if let row = value("-scroll", in: arguments) { run.list.scroll(to: row, animated: false) }
                    if arguments.contains("-abort") { run.open(.abort) }
                    if arguments.contains("-aborted") { await run.feed.abort() }
                    if let row = value("-select", in: arguments) { run.list.onSelect?(row) }
                }
            case "instructions", "security":
                let page = PolicyDocumentViewController(document: open == "security" ? .security : .instructions, session: session)
                navigation.pushViewController(page, animated: false)
                if let text = value("-append", in: arguments) {
                    try? await Task.sleep(for: .seconds(1))
                    page.textView.becomeFirstResponder()
                    page.textView.text += text
                    page.textViewDidChange(page.textView)
                    if arguments.contains("-save") { await page.save() }
                }
            case "settings":
                navigation.pushViewController(SettingsViewController(context: context, computer: connection.id), animated: false)
                try? await Task.sleep(for: .seconds(1.5))
                if let scroll = navigation.topViewController?.view.subviews.compactMap({ $0 as? UIScrollView }).first {
                    scroll.setContentOffset(CGPoint(x: 0, y: max(0, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom) * 0.55), animated: false)
                }
            case "providers":
                let providers = ProvidersViewController(session: session)
                navigation.pushViewController(providers, animated: false)
                try? await Task.sleep(for: .seconds(1))
                if arguments.contains("-choose") { providers.choose() }
                if arguments.contains("-custom") {
                    providers.addCustom()
                    try? await Task.sleep(for: .seconds(1))
                    if let form = navigation.topViewController as? FieldsFormViewController { fill(form, arguments: arguments) }
                }
            case let open? where open.hasPrefix("plugin:"):
                navigation.pushViewController(PluginsViewController(session: session), animated: false)
                PluginScreens.open(pluginId: String(open.dropFirst("plugin:".count)), session: session, from: navigation)
                await act(on: navigation, session: session, arguments: arguments)
            default:
                break
            }
            // `-keep <name>`: what the opened screen shows once it settles, as `Documents/<name>.png` (a device).
            if let name = value("-keep", in: arguments) {
                try? await Task.sleep(for: .seconds(4))
                Self.keep(window, as: name)
            }
        } catch {
            print("CLUSTER_HARNESS error: \(error)")
        }
    }

    /// Walks the onboarding flow over `home`, a step every two seconds:
    /// `name:<name>` saves the profile, `bot:<name>` names the admin bot,
    /// `custom` opens the custom provider's form and `fill` fills it (`-fill`),
    /// `family:<kind>` picks a family in the open provider chooser,
    /// `shot:<name>` keeps the window as `Documents/<name>.png` (a device),
    /// `photo` picks a picture, `plugin:<id>` opens a plugin from the
    /// plugins step, `install` and `setup:<method>` act on its page and
    /// `submit` sends a form, `email:<address>` invites (typed only with a
    /// trailing `+`), `back` goes back, `skip` and `primary` tap the
    /// screen's actions.
    private func walk(_ steps: String, home: UIViewController, window: UIWindow, arguments: [String]) async {
        for step in steps.split(separator: ",") {
            try? await Task.sleep(for: .seconds(2))
            let top = (home.presentedViewController as? UINavigationController)?.topViewController
            if step.hasPrefix("name:"), let profile = top as? CloudProfileViewController {
                profile.nameField.text.text = String(step.dropFirst("name:".count))
                profile.edited()
                await profile.submit()
            } else if step.hasPrefix("bot:"), let bot = top as? OnboardingAdminBotViewController {
                bot.nameField.text.text = String(step.dropFirst("bot:".count))
                bot.edited()
                await bot.submit()
            } else if step == "custom", let inference = top as? OnboardingInferenceViewController {
                inference.chooser.addCustom()
            } else if step.hasPrefix("family:"), let chooser = (top?.presentedViewController as? UINavigationController)?.topViewController as? SettingsPageViewController {
                chooser.tapRow("provider-family-\(step.dropFirst("family:".count))")
            } else if step.hasPrefix("plugin:"), let plugins = top as? OnboardingPluginsViewController {
                plugins.view.findButton(identifier: "onboarding-plugin-\(step.dropFirst("plugin:".count))")?.tapped()
            } else if step == "install", let page = top as? PluginViewController, let plugin = page.session.plugins.state.catalog?.plugin(page.pluginId) {
                page.install(plugin)
            } else if step.hasPrefix("setup:"), let page = top as? PluginViewController, let catalog = page.session.plugins.state.catalog,
                      let installation = catalog.installations(of: page.pluginId).last,
                      let method = catalog.plugin(page.pluginId)?.authMethods.first(where: { $0.id == step.dropFirst("setup:".count) }) {
                page.setUp(installation, method: method)
            } else if step == "fill", let form = top as? FieldsFormViewController {
                fill(form, arguments: arguments)
            } else if step == "submit", let form = top as? FieldsFormViewController {
                form.connect()
            } else if step.hasPrefix("email:"), let teammates = top as? OnboardingTeammatesViewController {
                let address = step.dropFirst("email:".count)
                teammates.emailField.text.text = String(address.hasSuffix("+") ? address.dropLast() : address)
                teammates.edited()
                if !address.hasSuffix("+") { teammates.primary.tapped() }
            } else if step.hasPrefix("shot:") {
                Self.keep(window, as: String(step.dropFirst("shot:".count)))
            } else if step == "back" {
                (home.presentedViewController as? UINavigationController)?.popViewController(animated: true)
            } else if step == "photo", let photo = top as? OnboardingPhotoViewController {
                photo.choose(CloudProfileViewController.previewPhoto())
            } else if let notice = top as? CloudStageViewController {
                if step == "skip" { notice.secondary?.tapped() } else if step == "primary" { notice.primary.tapped() }
            }
        }
    }

    private static func keep(_ window: UIWindow, as name: String) {
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        try? image.pngData()?.write(to: documents.appendingPathComponent("\(name).png"))
    }

    /// On a plugin's page: `-setup <installation>:<method>` opens that
    /// setup, `-type <text>` types into its first field and `-submit`
    /// sends it; `-remove <installation>` asks to remove it; `-install`
    /// installs the plugin again.
    private func act(on navigation: UINavigationController, session: Session, arguments: [String]) async {
        func value(_ flag: String) -> String? { arguments.firstIndex(of: flag).flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil } }
        try? await Task.sleep(for: .seconds(1))
        guard let page = navigation.topViewController as? PluginViewController, let catalog = session.plugins.state.catalog else { return }
        if arguments.contains("-install"), let plugin = catalog.plugin(page.pluginId) { page.install(plugin) }
        if let target = value("-remove"), let installation = catalog.installations?.first(where: { $0.id == target }) { page.confirmRemove(installation) }
        guard let setup = value("-setup")?.split(separator: ":").map(String.init), setup.count == 2,
              let installation = catalog.installations?.first(where: { $0.id == setup[0] }),
              let method = catalog.plugin(installation.pluginId)?.authMethods.first(where: { $0.id == setup[1] }) else { return }
        page.setUp(installation, method: method)
        try? await Task.sleep(for: .seconds(1))
        guard let form = navigation.topViewController as? FieldsFormViewController else { return }
        if let text = value("-type"), let field = form.view.firstField() {
            field.text = text
            field.sendActions(for: .editingChanged)
        }
        if arguments.contains("-submit") { form.connect() }
    }
}

/// `-fill key=value,key=value` types into a form's fields; `-submit` sends it.
private func value(_ flag: String, in arguments: [String]) -> String? {
    arguments.firstIndex(of: flag).flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil }
}

@MainActor
private func fill(_ form: FieldsFormViewController, arguments: [String]) {
    let pairs = arguments.firstIndex(of: "-fill").flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil }?.split(separator: ",") ?? []
    for pair in pairs {
        let parts = pair.split(separator: "=", maxSplits: 1).map(String.init)
        guard parts.count == 2, let field = form.view.field(identifier: "form-field-\(parts[0])") else { continue }
        field.text = parts[1]
        field.sendActions(for: .editingChanged)
    }
    if arguments.contains("-submit") { form.connect() }
}

private extension UIView {
    func field(identifier: String) -> UITextField? {
        if let field = self as? UITextField, field.accessibilityIdentifier == identifier { return field }
        for child in subviews { if let found = child.field(identifier: identifier) { return found } }
        return nil
    }

    func findButton(identifier: String) -> RoundButton? {
        if let button = self as? RoundButton, button.accessibilityIdentifier == identifier { return button }
        for child in subviews { if let found = child.findButton(identifier: identifier) { return found } }
        return nil
    }

    func firstField() -> UITextField? {
        if let field = self as? UITextField { return field }
        for child in subviews { if let found = child.firstField() { return found } }
        return nil
    }
}
#endif
