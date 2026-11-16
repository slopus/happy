#if canImport(UIKit)
import Foundation
import HappyCore
import HappyIcons
import HappyLayout
import HappyWire
import UIKit

/// Which of a pipeline's pages: the pipeline, one version of it, or one
/// node of a version (nil, the head).
enum PipelineScreen: Equatable, Sendable {
    case pipeline
    case version(Int)
    case node(version: Int?, nodeId: String)
}

/// Names for what definitions name by ID, from the account's directory.
struct PipelineNames: Equatable, Sendable {
    var agents: [String: String] = [:]
    var people: [String: String] = [:]
    /// Vaults and other surfaces.
    var surfaces: [String: String] = [:]
    /// The person reading.
    var me: String?
}

/// What a pipeline's pages derive from: which page, the pipeline feed's
/// state, names, and the screen's environment.
struct PipelineInput: Sendable {
    var screen: PipelineScreen
    var state = PipelineFeed.State()
    var names = PipelineNames()
    var env = PipelineCardEnvironment()
}

/// A pipeline's page (desktop's HappyAgentPipelinePage on a phone), worked
/// out off the main thread: how it stands, what its latest version defines
/// (concurrency, who may start it, its input and output, its nodes in
/// graph order, what it is granted), its history, and its runs at the foot,
/// the next page read once the last shows. A version's page shows that
/// version's definition the same way; a node's page what one node is.
/// Read only.
enum PipelineItems {
    typealias Text = Strings.Pipelines
    typealias Rows = [(CardPlace) -> (CardItem, PipelineRowTarget?)]

    nonisolated static func page(_ input: PipelineInput) -> PipelinePage {
        guard input.env.width > 0 else { return PipelinePage() }
        switch input.screen {
        case .pipeline: return pipeline(input)
        case .version(let number): return version(number, input)
        case .node(let number, let nodeId): return node(nodeId, version: number, input)
        }
    }

    nonisolated static func ticking(_ input: PipelineInput) -> Bool {
        input.screen == .pipeline && input.state.runs.entries.contains { $0.state.abortable && $0.startedAt != nil }
    }

    // MARK: The pipeline

    nonisolated static func pipeline(_ input: PipelineInput) -> PipelinePage {
        let (state, env) = (input.state, input.env)
        var page = PipelinePage()
        page.title = state.name
        if let pipeline = state.pipeline {
            if state.failed { page.append(PipelineRows.note("pipeline:failed", Text.pipelineOutOfDate, env)) }
            header(pipeline, input, into: &page)
            switch state.definitions[pipeline.head.number] {
            case .loaded(let definition)?: Self.definition(definition, version: nil, input, into: &page)
            case .failed?: page.append(PipelineRows.note("definition:note", Text.definitionUnreadable, env))
            default: page.append(PipelineRows.note("definition:note", Text.definitionLoading, env))
            }
            versions(pipeline, input, into: &page)
        } else if state.loading {
            page.append(PipelineRows.note("pipeline:note", Text.pipelineLoading, whole: true, env))
            return page
        } else if state.missing, state.archived || !state.runs.entries.isEmpty {
            // Gone from every route but its runs: archived.
            page.append(PipelineRows.heading("pipeline:heading", Text.pipeline, afterCard: false, env))
            page.card([{ place in
                (PipelineRows.row("pipeline:status", title: Text.archived, subtitle: Text.archivedNote, tile: PipelineRows.neutral(.ionicons("archive-outline")),
                                  place: place, subtitleLines: 0, env), nil)
            }])
        } else {
            page.append(PipelineRows.note("pipeline:note", state.missing ? Text.pipelineMissing : Text.pipelineUnreadable, env))
        }
        runs(input, into: &page)
        return page
    }

    nonisolated static func header(_ pipeline: PipelineDetail, _ input: PipelineInput, into page: inout PipelinePage) {
        let env = input.env
        page.append(PipelineRows.heading("pipeline:heading", Text.pipeline, trailing: Text.runOf(version: pipeline.head.number), afterCard: false, env))
        var rows: Rows = [{ place in
            let tile = pipeline.enabled ? PipelineRows.Tile(icon: Glyphs.icon("pipeline"), ink: Palette.tileTeal, fill: Palette.tileTealFill)
                : PipelineRows.neutral(Glyphs.icon("pipeline"))
            return (PipelineRows.row("pipeline:status", title: pipeline.enabled ? Text.enabled : Text.disabledNote, subtitle: pipeline.description,
                                     tile: tile, place: place, subtitleLines: 0, env), nil)
        }]
        if let run = pipeline.lastRun {
            rows.append { place in
                (PipelineRows.row("pipeline:last-run", title: Text.lastRunLabel, subtitle: Text.state(run.state),
                                  trailing: PipelineRunItems.ago(run.endedAt ?? run.createdAt, env), tile: PipelineRows.tile(run.state), place: place, opens: true, env),
                 .run(run.id, pipelineName: pipeline.name))
            }
        }
        if let creator = pipeline.createdBy {
            let name = Text.creator(creator, people: input.names.people, me: input.names.me)
            rows.append { place in (PipelineRows.fact("pipeline:created", Text.createdBy, name, place: place, env), nil) }
        }
        rows.append { place in (PipelineRows.fact("pipeline:updated", Text.updated, PipelineRunItems.moment(pipeline.updatedAt, env), place: place, env), nil) }
        page.card(rows)
    }

    nonisolated static func versions(_ pipeline: PipelineDetail, _ input: PipelineInput, into page: inout PipelinePage) {
        let (versions, env) = (input.state.versions, input.env)
        page.append(PipelineRows.heading("versions", Text.versions, trailing: versions.isEmpty ? nil : Text.versionsCount(versions.count), afterCard: true, env))
        guard !versions.isEmpty else {
            page.append(PipelineRows.note("versions:note", Text.versionsLoading, env))
            return
        }
        page.card(versions.map { version in { place in
            let latest = version.number == pipeline.head.number
            let author = Text.author(version.author, agents: input.names.agents, people: input.names.people, me: input.names.me)
            let tile = PipelineRows.Tile(icon: .ionicons("git-commit-outline"), ink: latest ? Palette.tileTeal : Palette.settingsSecondary,
                                         fill: latest ? Palette.tileTealFill : Palette.surfaceHighest)
            return (PipelineRows.row("version:\(version.number)", title: Text.versionTitle(version.number, latest: latest),
                                     subtitle: (version.message.isEmpty ? Text.versionNoMessage : version.message) + "\n" + author,
                                     trailing: PipelineRunItems.ago(version.createdAt, env), tile: tile, place: place, opens: true, subtitleLines: 3, env),
                    .version(version.number))
        } })
    }

    /// The pipeline's runs, as the list shows them, the next page asked for once the last shows.
    nonisolated static func runs(_ input: PipelineInput, into page: inout PipelinePage) {
        let (runs, env) = (input.state.runs, input.env)
        page.append(PipelineRows.heading("runs", Text.runs, afterCard: true, env))
        guard !runs.entries.isEmpty else {
            page.append(PipelineRows.note("runs:note", runs.loading ? Text.runsLoading : runs.failed ? Text.runsOutOfDate : Text.thisPipelineRunsEmpty, env))
            return
        }
        page.card(runs.entries.map { run in { place in
            (PipelineListItems.row(run, title: Text.state(run.state), place: place, parent: [:], agents: input.names.agents, env), .run(run.id, pipelineName: input.state.name))
        } })
        if runs.loadingMore { page.append(PipelineRows.note("runs:more", Text.runsLoadingMore, env)) }
        else if runs.failed { page.append(PipelineRows.note("runs:failed", Text.runsOutOfDate, env)) }
        if runs.nextCursor != nil, !runs.loadingMore, let last = runs.entries.last { page.more = PipelineListItems.runId(last.id) }
    }

    // MARK: A version

    nonisolated static func version(_ number: Int, _ input: PipelineInput) -> PipelinePage {
        let (state, env) = (input.state, input.env)
        var page = PipelinePage()
        page.title = Text.versionTitle(number, latest: false)
        let head = state.pipeline?.head.number
        let version = state.versions.first { $0.number == number }
        page.append(PipelineRows.heading("version:heading", state.pipeline?.name ?? Text.versions, trailing: number == head ? Text.latest : nil, afterCard: false, env))
        var rows: Rows = []
        if let version {
            let author = Text.author(version.author, agents: input.names.agents, people: input.names.people, me: input.names.me)
            rows.append { place in
                (PipelineRows.row("version:message", title: version.message.isEmpty ? Text.versionNoMessage : version.message,
                                  subtitle: "\(author) · \(PipelineRunItems.moment(version.createdAt, env))", tile: PipelineRows.neutral(.ionicons("git-commit-outline")),
                                  place: place, titleLines: 0, env), nil)
            }
            if !version.digest.isEmpty {
                // `sha256:<hex>`: its first hex digits are enough to tell it apart.
                let hash = version.digest.split(separator: ":").last.map(String.init) ?? version.digest
                rows.append { place in (PipelineRows.fact("version:digest", Text.digest, String(hash.prefix(12)), place: place, env), nil) }
            }
        }
        if !rows.isEmpty { page.card(rows) }
        switch state.definitions[number] {
        case .loaded(let definition)?: Self.definition(definition, version: number, input, into: &page)
        case .failed?: page.append(PipelineRows.note("definition:note", Text.definitionUnreadable, env))
        default: page.append(PipelineRows.note("definition:note", Text.definitionLoading, whole: rows.isEmpty, env))
        }
        return page
    }

    // MARK: A definition

    /// What a version defines, the same on the pipeline's page and a version's.
    nonisolated static func definition(_ definition: PipelineDefinition, version: Int?, _ input: PipelineInput, into page: inout PipelinePage) {
        let env = input.env
        let pipelines = input.state.names

        // How runs share the cluster, and who may start one.
        page.append(PipelineRows.heading("concurrency", Text.concurrency, afterCard: true, env))
        var lines = [Text.mode(definition.mode), Text.group(definition.group)]
        if definition.batch { lines.append(Text.batching) }
        page.card(lines.enumerated().map { index, line in { place in
            (PipelineRows.row("concurrency:\(index)", title: line.title, subtitle: line.detail, place: place, subtitleLines: 0, env), nil)
        } })
        page.append(PipelineRows.heading("triggers", Text.startedByHeading, afterCard: true, env))
        if definition.triggerAgents.isEmpty {
            page.append(PipelineRows.note("triggers:none", Text.noTrigger, env))
        } else {
            page.card(definition.triggerAgents.map { agent in { place in
                (PipelineRows.row("trigger:\(agent)", title: input.names.agents[agent].flatMap { $0.isEmpty ? nil : $0 } ?? agent,
                                  tile: PipelineRows.neutral(.ionicons("person-outline")), place: place, env), nil)
            } })
        }

        // Its input and output.
        page.append(PipelineRows.heading("input", Text.input, afterCard: true, env))
        page.card(typeRows("input", definition.input, schema: definition.inputSchema, title: Text.input, env))
        page.append(PipelineRows.heading("output", Text.output, afterCard: true, env))
        let outputs = definition.outputs
        page.card(outputs.flatMap { field -> Rows in
            // Each ending node's output, then its fields under its name.
            let fields: Rows = field.type.kind == .object ? flatten(field.type, prefix: field.name + ".").map { inner in { place in
                (PipelineRows.row("output:\(inner.path)", title: inner.path, subtitle: Text.requirement(inner.required), trailing: Text.type(inner.type),
                                  place: place, mono: true, env), nil)
            } } : []
            return [{ place in
                (PipelineRows.row("output:\(field.name)", title: field.name, subtitle: Text.outputPresence(field.required), trailing: Text.type(field.type),
                                  place: place, mono: true, env), nil)
            }] + fields
        } + [{ place in schemaRow("output:schema", Text.output, definition.outputSchema, place: place, env) }])

        // Its nodes, in graph order.
        let order = definition.graph.order
        page.append(PipelineRows.heading("nodes", Text.graph, trailing: Text.nodesCount(order.count), afterCard: true, env))
        page.card(order.compactMap { definition.nodes[$0] }.map { node in { place in
            (nodeRow(node, definition: definition, pipelines: pipelines, place: place, env), .definitionNode(version: version, nodeId: node.id))
        } })

        // What it is granted, the pipeline's ceiling then each node.
        page.append(PipelineRows.heading("permissions", Text.permissions, afterCard: true, env))
        let name = names(input)
        var rows: Rows = []
        let ceiling = Text.grants(definition.permissions, name: name)
        rows.append { place in
            (PipelineRows.row("permissions:pipeline", title: Text.ceiling, subtitle: ceiling.isEmpty ? Text.nothingGrantedNote : ceiling.map { "\($0.title): \($0.detail)" }.joined(separator: "\n"),
                              tile: PipelineRows.neutral(.ionicons(ceiling.isEmpty ? "lock-closed-outline" : "shield-checkmark-outline")), place: place, subtitleLines: 0, env), nil)
        }
        for id in order {
            guard let node = definition.nodes[id] else { continue }
            let granted = node.permissions.map { Text.grants($0, name: name) } ?? []
            rows.append { place in
                (PipelineRows.row("permissions:\(id)", title: id, subtitle: granted.isEmpty ? Text.nothingGranted : granted.map { "\($0.title): \($0.detail)" }.joined(separator: "\n"),
                                  place: place, opens: true, subtitleColor: Palette.settingsSecondary, subtitleLines: 0, env),
                 .definitionNode(version: version, nodeId: id))
            }
        }
        page.card(rows)
    }

    /// A node's row in the graph: its kind, whether it is the root, and where it leads.
    nonisolated static func nodeRow(_ node: PipelineDefinitionNode, definition: PipelineDefinition, pipelines: [String: String], place: CardPlace,
                                    _ env: PipelineCardEnvironment) -> CardItem {
        let out = definition.edges.filter { $0.from == node.id }
        var kind = Text.definitionKind(node, pipeline: node.pipeline.map { pipelines[$0] ?? $0 })
        if node.id == definition.root { kind = Text.root + " · " + kind }
        let leads = Text.leads(success: out.filter { $0.on == "success" }.map(\.to), failure: out.filter { $0.on == "failure" }.map(\.to))
        return PipelineRows.row("def-node:\(node.id)", title: node.id, subtitle: kind + "\n" + leads, tile: tile(node), place: place, opens: true, subtitleLines: 0, env)
    }

    nonisolated static func tile(_ node: PipelineDefinitionNode) -> PipelineRows.Tile {
        switch node.kind {
        case "agent": PipelineRows.Tile(icon: .ionicons("sparkles-outline"), ink: Palette.tilePurple, fill: Palette.tilePurpleFill)
        case "pipeline": PipelineRows.Tile(icon: Glyphs.icon("pipeline"), ink: Palette.tileTeal, fill: Palette.tileTealFill)
        default: PipelineRows.Tile(icon: .ionicons("code-slash-outline"), ink: Palette.tileBlue, fill: Palette.tileBlueFill)
        }
    }

    /// A type as its fields: name, type, whether required; nested objects'
    /// fields by their path. The raw schema opens behind the last row.
    nonisolated static func typeRows(_ id: String, _ type: PipelineType?, schema: JSONValue?, title: String, _ env: PipelineCardEnvironment) -> Rows {
        var rows: Rows = []
        if let type {
            let fields = flatten(type)
            if type.kind == .object, !fields.isEmpty {
                for field in fields {
                    rows.append { place in
                        (PipelineRows.row("\(id):\(field.path)", title: field.path, subtitle: [Text.requirement(field.required), field.type.description].compactMap { $0 }.joined(separator: " · "),
                                          trailing: Text.type(field.type), place: place, subtitleLines: 3, mono: true, env), nil)
                    }
                }
            } else {
                rows.append { place in (PipelineRows.row("\(id):whole", title: Text.wholeType(type), subtitle: type.description, place: place, titleLines: 2, env), nil) }
            }
        }
        rows.append { place in schemaRow("\(id):schema", title, schema, place: place, env) }
        return rows
    }

    nonisolated static func schemaRow(_ id: String, _ title: String, _ schema: JSONValue?, place: CardPlace, _ env: PipelineCardEnvironment) -> (CardItem, PipelineRowTarget?) {
        (PipelineRows.row(id, title: Text.rawSchema, tile: PipelineRows.neutral(.ionicons("code-outline")), place: place, opens: true, titleColor: Palette.tileBlue, env),
         .text(title: title, text: Text.value(schema)))
    }

    /// An object's fields, nested ones under their parent's path (`repo.branch`, `files[].path`).
    nonisolated static func flatten(_ type: PipelineType, prefix: String = "", depth: Int = 0) -> [(path: String, type: PipelineType, required: Bool)] {
        guard depth < 4 else { return [] }
        var out: [(path: String, type: PipelineType, required: Bool)] = []
        for field in type.fields {
            let path = prefix + field.name
            out.append((path, field.type, field.required))
            if field.type.kind == .object { out += flatten(field.type, prefix: path + ".", depth: depth + 1) }
            if field.type.kind == .array, let items = field.type.items.first, items.kind == .object {
                out += flatten(items, prefix: path + "[].", depth: depth + 1)
            }
        }
        return out
    }

    /// Names for IDs a permission names, where this app knows them.
    nonisolated static func names(_ input: PipelineInput) -> (String, String) -> String {
        let (names, pipelines) = (input.names, input.state.names)
        return { kind, id in
            switch kind {
            case "vault": names.surfaces[id] ?? id
            case "agent": names.agents[id].flatMap { $0.isEmpty ? nil : $0 } ?? id
            case "pipeline": pipelines[id] ?? id
            default: id
            }
        }
    }

    // MARK: A node of a version

    nonisolated static func node(_ nodeId: String, version number: Int?, _ input: PipelineInput) -> PipelinePage {
        let (state, env) = (input.state, input.env)
        var page = PipelinePage()
        page.title = nodeId
        guard let number = number ?? state.pipeline?.head.number else {
            page.append(PipelineRows.note("def-node:note", Text.pipelineLoading, whole: true, env))
            return page
        }
        guard case .loaded(let definition)? = state.definitions[number] else {
            let failed = state.definitions[number] == .failed
            page.append(PipelineRows.note("def-node:note", failed ? Text.definitionUnreadable : Text.definitionLoading, whole: true, env))
            return page
        }
        guard let node = definition.nodes[nodeId] else {
            page.append(PipelineRows.note("def-node:note", Text.nodeMissing, whole: true, env))
            return page
        }
        let pipelineName = node.pipeline.map { state.names[$0] ?? $0 }
        page.append(PipelineRows.heading("def-node:heading", Text.node, trailing: Text.versionTitle(number, latest: number == state.pipeline?.head.number), afterCard: false, env))
        let out = definition.edges.filter { $0.from == node.id }
        var facts: Rows = [{ place in
            (PipelineRows.row("def-node:kind", title: node.id == definition.root ? Text.root + " · " + Text.definitionKind(node, pipeline: pipelineName)
                                : Text.definitionKind(node, pipeline: pipelineName),
                              subtitle: Text.leads(success: out.filter { $0.on == "success" }.map(\.to), failure: out.filter { $0.on == "failure" }.map(\.to)),
                              tile: tile(node), place: place, titleLines: 0, subtitleLines: 0, env), nil)
        }]
        if let pipeline = node.pipeline {
            facts.append { place in
                (PipelineRows.row("def-node:pipeline", title: Text.childPipeline, trailing: pipelineName, place: place, opens: true, env), .pipeline(pipeline, name: state.names[pipeline]))
            }
        }
        facts.append { place in (PipelineRows.fact("def-node:timeout", Text.timesOut, Text.seconds(node.timeoutSeconds), place: place, env), nil) }
        if definition.edges.filter({ $0.to == node.id }).count > 1 {
            facts.append { place in (PipelineRows.fact("def-node:join", Text.runsWhen, Text.join(node.join), place: place, env), nil) }
        }
        page.card(facts)

        page.append(PipelineRows.heading("def-node:input", Text.input, afterCard: true, env))
        page.card(typeRows("def-node:input", node.input, schema: node.inputSchema, title: Text.input, env))
        page.append(PipelineRows.heading("def-node:output", Text.output, afterCard: true, env))
        page.card(typeRows("def-node:output", node.output, schema: node.outputSchema, title: Text.output, env))

        page.append(PipelineRows.heading("def-node:permissions", Text.permissions, afterCard: true, env))
        let granted = node.permissions.map { Text.grants($0, name: names(input)) } ?? []
        if granted.isEmpty {
            page.append(PipelineRows.note("def-node:permissions-none", Text.nodeNothingGranted, env))
        } else {
            page.card(granted.enumerated().map { index, line in { place in
                (PipelineRows.row("def-node:grant:\(index)", title: line.title, subtitle: line.detail, place: place, subtitleLines: 0, env), nil)
            } })
        }
        let leases = Text.leases(node)
        if !leases.isEmpty {
            page.append(PipelineRows.heading("def-node:compute", Text.compute, afterCard: true, env))
            page.card(leases.enumerated().map { index, line in { place in
                (PipelineRows.row("def-node:lease:\(index)", title: line.title, subtitle: line.detail, tile: PipelineRows.neutral(.ionicons("desktop-outline")),
                                  place: place, subtitleLines: 0, env), nil)
            } })
        }
        if let source = node.source {
            page.append(PipelineRows.heading("def-node:source", Text.source, afterCard: true, env))
            page.card([{ place in PipelineRunItems.block("def-node:source-text", node.id, source, place: place, env) }])
        }
        if let instructions = node.instructions {
            page.append(PipelineRows.heading("def-node:instructions", Text.instructions, afterCard: true, env))
            page.card([{ place in PipelineRunItems.block("def-node:instructions-text", node.id, instructions, place: place, mono: false, env) }])
        }
        return page
    }
}
#endif
