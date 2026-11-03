import Foundation
import HappyWire

/// Everything a Feed entry can name, as this account syncs it: tasks and
/// bots (archived ones too), Surfaces, artifacts (deleted ones too), the
/// todos entries point at, projects, workspaces, agents and people. An
/// entry carries references only (API.md "Showing an entry"); its row is
/// joined from this, so a rename or a new picture shows in every row at
/// once, and a row whose subject isn't here isn't shown.
///
/// Made off the main thread by the engine (`SyncEngine.feedDirectories`)
/// from its bootstrap, its team users, its artifact catalog and the few
/// things only the Feed names (`FeedLookups`), with this phone's pending
/// renames laid over; one per account, shared by every screen.
public struct FeedDirectory: Equatable, Sendable {
    /// A task, bot, project or workspace: what it is called and its face.
    public struct Place: Equatable, Sendable {
        public var name: String
        public var mark: Row.Mark
        /// A task's or bot's conversation, which opens it.
        public var agentId: String?
        public var archived: Bool
        /// A team task's member, whose face it wears.
        public var owner: String?

        public init(name: String, mark: Row.Mark = .none, agentId: String? = nil, archived: Bool = false, owner: String? = nil) {
            self.name = name
            self.mark = mark
            self.agentId = agentId
            self.archived = archived
            self.owner = owner
        }
    }

    public struct Surface: Equatable, Sendable {
        public var name: String
        /// `todo`, `document`, `calendar`, …
        public var type: String
        /// Its picture's ThumbHash, when it has one (`/v0/surfaces/:id/image`).
        public var image: String?

        public init(name: String, type: String, image: String? = nil) {
            self.name = name
            self.type = type
            self.image = image
        }
    }

    /// An agent as an actor: what it is called and the face it wears, its
    /// bot's or task's for theirs, its own placeholder otherwise, as a
    /// chat's profile wears it (`SidebarRows.profileMark`).
    public struct Agent: Equatable, Sendable {
        public var name: String
        public var mark: Row.Mark

        public init(name: String, mark: Row.Mark) {
            self.name = name
            self.mark = mark
        }
    }

    public var tasks: [String: Place] = [:]
    public var bots: [String: Place] = [:]
    public var surfaces: [String: Surface] = [:]
    public var artifacts: [String: ArtifactSummary] = [:]
    public var projects: [String: Place] = [:]
    public var workspaces: [String: Place] = [:]
    public var agents: [String: Agent] = [:]
    public var people: [String: TeamUser] = [:]
    /// Todos by `FeedDirectory.todoKey`, deleted ones too.
    public var todos: [String: TodoItem] = [:]
    /// The person reading: their team user (nil standalone) and their
    /// picture's ThumbHash.
    public var userId: String?
    public var photo: String?
    /// The bootstrap has been read, from disk or the computer: a subject
    /// it doesn't hold is gone, not on its way.
    public var loaded = false

    public init() {}

    public static func todoKey(_ surfaceId: String, _ todoId: String) -> String { "\(surfaceId)/\(todoId)" }

    /// The directory from what the account syncs: `desktop` with its
    /// `users`, the artifact catalog, what was looked up, and the names
    /// this phone gave things that the computer hasn't taken yet.
    public static func make(desktop: DesktopSnapshot?, users: [String: TeamUser], artifacts: [ArtifactSummary], found: FeedLookups.Found = .init(), titles: [String: String] = [:]) -> FeedDirectory {
        var directory = FeedDirectory()
        directory.people = found.people.merging(users) { _, synced in synced }
        for artifact in found.artifacts.values { directory.artifacts[artifact.id] = artifact }
        for artifact in artifacts { directory.artifacts[artifact.id] = artifact }
        for (key, todo) in found.todos { directory.todos[key] = todo }
        for (id, title) in found.agents { directory.agents[id] = Agent(name: title, mark: .placeholder(seed: id)) }
        for (id, place) in found.projects {
            directory.projects[id] = Place(name: place.name, mark: SidebarRows.projectMark(id: id, avatar: place.avatar), archived: place.status == "archived")
        }
        for (id, place) in found.workspaces { directory.workspaces[id] = Place(name: place.name, archived: place.status == "archived") }
        guard let desktop else { return directory }
        directory.loaded = true
        directory.userId = desktop.profile?.userId
        directory.photo = desktop.profile?.photo?.thumbhash
        func agents(_ agent: AgentWire.Agent) {
            if directory.agents[agent.id] == nil || agent.title != nil {
                directory.agents[agent.id] = Agent(name: agent.title ?? "", mark: .placeholder(seed: agent.id))
            }
            for child in agent.subtasks ?? [] { agents(child) }
        }
        for agent in desktop.archivedAgents ?? [] { agents(agent) }
        for project in desktop.projects {
            directory.projects[project.id] = Place(name: project.name, mark: SidebarRows.projectMark(project), archived: project.status == "archived")
            project.agents.forEach(agents)
        }
        for workspace in desktop.workspaces {
            directory.workspaces[workspace.id] = Place(name: workspace.name, archived: workspace.status == "archived")
            workspace.agents.forEach(agents)
        }
        for surface in desktop.surfaces ?? [] {
            directory.surfaces[surface.id] = Surface(name: titles[surface.id] ?? surface.name, type: surface.type, image: surface.image?.thumbhash)
        }
        // Bots and tasks last: their own conversations wear their faces
        // and names, whatever else lists them.
        for (kind, owners) in [("bot", desktop.bots ?? []), ("task", desktop.tasks ?? [])] {
            for owner in owners {
                let mark = SidebarRows.ownerMark(kind: kind, owner, profile: desktop.profile, users: directory.people)
                let name = titles[owner.id] ?? owner.name ?? owner.agent?.title ?? ""
                let place = Place(name: name, mark: mark, agentId: owner.agent?.id, archived: owner.status == "archived", owner: kind == "task" ? owner.ownerUserId : nil)
                if kind == "bot" { directory.bots[owner.id] = place } else { directory.tasks[owner.id] = place }
                guard let agent = owner.agent else { continue }
                agents(agent)
                directory.agents[agent.id] = Agent(name: name, mark: mark)
            }
        }
        return directory
    }

    /// What `items` and `clusters` name that this directory doesn't hold,
    /// to look up. Tasks, bots and Surfaces come whole with the bootstrap,
    /// so one it lacks is gone, never asked for.
    public func missing(_ items: [FeedItem], clusters: [FeedCluster] = []) -> FeedLookups.Wanted {
        var wanted = references(items, clusters: clusters)
        wanted.agents = wanted.agents.filter { agents[$0] == nil }
        wanted.people = wanted.people.filter { people[$0] == nil }
        wanted.projects = wanted.projects.filter { projects[$0] == nil }
        wanted.workspaces = wanted.workspaces.filter { workspaces[$0] == nil }
        wanted.artifacts = wanted.artifacts.filter { artifacts[$0] == nil }
        wanted.todos = wanted.todos.filter { todos[$0] == nil }
        return wanted
    }

    /// Everything `items` and `clusters` name that a lookup could hold,
    /// held or not.
    public func references(_ items: [FeedItem], clusters: [FeedCluster] = []) -> FeedLookups.Wanted {
        var named = FeedLookups.Wanted()
        for item in items {
            switch item.subject.type {
            case "artifact":
                named.artifacts.insert(item.subject.id)
            case "surface":
                if item.latest?.type == "todo.created", let todoId = item.latest?.todoId {
                    named.todos.insert(Self.todoKey(item.subject.id, todoId))
                }
            case "task":
                // Its member's face, in a team: one home doesn't list (an
                // archived task's) is read here.
                if userId != nil, let owner = tasks[item.subject.id]?.owner, owner != userId { named.people.insert(owner) }
            default:
                break
            }
            for actor in item.actors {
                if let agentId = actor.agentId { named.agents.insert(agentId) }
                if let id = actor.userId, id != userId { named.people.insert(id) }
            }
        }
        for cluster in clusters {
            guard let id = cluster.placeId else { continue }
            switch cluster.kind {
            case "project": named.projects.insert(id)
            case "workspace": named.workspaces.insert(id)
            default: break
            }
        }
        return named
    }
}

/// Where opening a Feed entry goes.
public enum FeedTarget: Equatable, Sendable {
    /// A task's or bot's chat, by its conversation.
    case chat(agentId: String, title: String)
    case surface(AgentWire.Surface)
    case artifact(Artifact)
}

/// Who acted, as VoiceOver says them.
public enum FeedActorName: Equatable, Sendable {
    /// The person reading.
    case you
    case named(String)
}

/// One Feed row, joined from its entry and the directory: everything the
/// row draws and opens, and nothing it doesn't, so two equal rows draw the
/// same and a rename changes exactly the rows that show the renamed thing.
public struct FeedRow: Equatable, Sendable, Identifiable {
    /// The entry's ID.
    public var id: String
    public var title: String
    public var face: FeedFace
    public var kind: FeedSubjectKind
    /// The newest change's own words: a new todo's text.
    public var detail: String?
    public var created: Bool
    public var updates: Int
    /// Who acted, the first few, in the order they first did.
    public var actors: [FeedFace]
    /// Those of them this phone knows the names of.
    public var actorNames: [FeedActorName]
    public var actorCount: Int
    /// When it last changed, ms since 1970.
    public var lastAt: Double
    public var unread: Bool
    /// Nil where nothing opens it (a deleted artifact).
    public var target: FeedTarget?
}

/// Feed rows from entries and the directory, off the main thread.
public enum FeedRows {
    /// The faces a row shows of who acted.
    public static let maxFaces = 3

    /// A row for each entry the directory can show, in their order; `unread`
    /// says which carry the dot. An entry whose subject the directory
    /// doesn't hold is left out, never shown with a stand-in.
    public static func make(_ items: [FeedItem], unread: (FeedItem) -> Bool, directory: FeedDirectory, personSeed: String) -> [FeedRow] {
        items.compactMap { row($0, unread: unread($0), directory: directory, personSeed: personSeed) }
    }

    public static func row(_ item: FeedItem, unread: Bool, directory: FeedDirectory, personSeed: String) -> FeedRow? {
        let id = item.subject.id
        let title: String
        let face: FeedFace
        let kind: FeedSubjectKind
        var detail: String?
        let target: FeedTarget?
        switch item.subject.type {
        case "task", "bot":
            let isBot = item.subject.type == "bot"
            guard let place = (isBot ? directory.bots : directory.tasks)[id], !place.name.isEmpty else { return nil }
            title = place.name
            face = .mark(place.mark == .none ? .placeholder(seed: id) : place.mark, round: false)
            kind = isBot ? .bot : .task
            target = place.agentId.map { .chat(agentId: $0, title: place.name) }
        case "surface":
            guard let surface = directory.surfaces[id], !surface.name.isEmpty else { return nil }
            title = surface.name
            kind = FeedSubjectKind(subject: "surface", surfaceType: surface.type)
            face = surface.image.map { .mark(.image(path: "/v0/surfaces/\(AgentClient.escape(id))/image", thumbhash: $0), round: false) } ?? .tile(kind, artifactType: nil)
            if item.latest?.type == "todo.created", let todoId = item.latest?.todoId, let todo = directory.todos[FeedDirectory.todoKey(id, todoId)] {
                detail = todo.heading ?? todo.text
            }
            target = .surface(AgentWire.Surface(id: id, type: surface.type, name: surface.name))
        case "artifact":
            guard let artifact = directory.artifacts[id], !artifact.title.isEmpty else { return nil }
            title = artifact.title
            kind = .artifact
            face = .tile(.artifact, artifactType: artifact.type)
            // A deleted one's versions are gone: it shows, and opens nothing.
            target = artifact.deleted ? nil : .artifact(artifact.artifact)
        default:
            return nil
        }
        let actors = item.actors.prefix(maxFaces).map { actor in self.face(actor, directory: directory, personSeed: personSeed) }
        let names = item.actors.compactMap { name($0, directory: directory) }
        return FeedRow(
            id: item.id, title: title, face: face, kind: kind,
            detail: detail.map(Self.oneLine).flatMap { $0.isEmpty ? nil : $0 },
            created: item.created, updates: item.updates, actors: actors, actorNames: names,
            actorCount: max(item.actorCount, item.actors.count), lastAt: item.lastAt, unread: unread, target: target
        )
    }

    static func oneLine(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\n", with: " ")
    }

    /// Who made a change: an agent wears its bot's or task's face, else
    /// its own placeholder; a person their picture or their placeholder,
    /// round; nobody (standalone) the installation's one person.
    public static func face(_ actor: FeedActor, directory: FeedDirectory, personSeed: String) -> FeedFace {
        if let agentId = actor.agentId {
            let mark = directory.agents[agentId]?.mark ?? .placeholder(seed: agentId)
            return .mark(mark == .none ? .placeholder(seed: agentId) : mark, round: false)
        }
        if let id = actor.userId {
            let photo = id == directory.userId ? directory.photo : directory.people[id]?.photo?.thumbhash
            return .mark(photo.map { .image(path: TeamUser.photoPath(id), thumbhash: $0) } ?? .placeholder(seed: id), round: true)
        }
        return .mark(directory.photo.map { .image(path: "/v0/profile/photo", thumbhash: $0) } ?? .placeholder(seed: personSeed), round: true)
    }

    /// What `actor` is called, nil while this phone doesn't know.
    public static func name(_ actor: FeedActor, directory: FeedDirectory) -> FeedActorName? {
        if let agentId = actor.agentId {
            guard let name = directory.agents[agentId]?.name, !name.isEmpty else { return nil }
            return .named(name)
        }
        if let id = actor.userId, id != directory.userId {
            guard let name = directory.people[id]?.name, !name.isEmpty else { return nil }
            return .named(name)
        }
        return .you
    }
}

/// A place in Following, joined from its cluster and the directory.
public struct FeedPlace: Equatable, Sendable, Identifiable {
    public enum Name: Equatable, Sendable {
        /// `*`.
        case everything
        case team
        case named(String)
    }

    /// The cluster.
    public var id: String
    public var name: Name
    public var face: FeedFace

    /// `cluster` as the directory names it; nil for a place it doesn't
    /// hold, or a kind this phone doesn't know.
    public init?(_ cluster: FeedCluster, directory: FeedDirectory) {
        id = cluster.cluster
        if cluster.cluster == "*" {
            name = .everything
            face = .clusterTile("everything")
            return
        }
        if cluster.kind == "team" {
            name = .team
            face = .clusterTile("team")
            return
        }
        guard let placeId = cluster.placeId else { return nil }
        let place: FeedDirectory.Place?
        switch cluster.kind {
        case "task": place = directory.tasks[placeId]
        case "bot": place = directory.bots[placeId]
        case "project": place = directory.projects[placeId]
        case "workspace": place = directory.workspaces[placeId]
        case "surface":
            guard let surface = directory.surfaces[placeId], !surface.name.isEmpty else { return nil }
            name = .named(surface.name)
            face = surface.image.map { .mark(.image(path: "/v0/surfaces/\(AgentClient.escape(placeId))/image", thumbhash: $0), round: false) } ?? .clusterTile("surface")
            return
        default: return nil
        }
        guard let place, !place.name.isEmpty else { return nil }
        name = .named(place.name)
        switch cluster.kind {
        case "task", "bot": face = .mark(place.mark == .none ? .placeholder(seed: placeId) : place.mark, round: false)
        case "project" where place.mark != .none: face = .mark(place.mark, round: false)
        default: face = .clusterTile(cluster.kind)
        }
    }
}
