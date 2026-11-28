#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Settings › Zones or Secrets, both read-only. Reuses settings' standard rows,
/// wrapping descriptions and access lists in the existing measured subtitle slot.
/// A zone (Zones v2) says whether it is restricted, its description, who may
/// join (people by name, teams by their `GET /v0/teams` name, an ID where
/// neither is known), and its internet and compute.
final class CloudMetadataViewController: SettingsPageViewController {
    enum Page: Sendable {
        case zones, secrets

        @MainActor var entry: SettingsIndex.Entry {
            switch self {
            case .zones: SettingsIndex.zones
            case .secrets: SettingsIndex.secrets
            }
        }
    }

    private enum Snapshot: Sendable {
        /// `names` are people's by user ID, `teams` teams' by ID.
        case zones([CloudZone], names: [String: String], teams: [String: String])
        case secrets([CloudSecretMetadata])
    }

    private let page: Page
    private let client: AgentClient
    private var read: Task<Void, Never>?
    private var snapshot: Snapshot?
    private var failed = false

    static func open(_ page: Page, session: Session, from controller: UIViewController) {
        guard session.isCloud else { return }
        controller.navigationController?.pushViewController(Self(page: page, client: session.client), animated: true)
    }

    private init(page: Page, client: AgentClient) {
        self.page = page
        self.client = client
        super.init(title: page.entry.title)
    }

    deinit { read?.cancel() }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        refresh()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        read?.cancel()
        read = nil
        snapshot = nil
    }

    private func refresh() {
        read?.cancel()
        failed = false
        reload()
        read = Task { [weak self, page, client] in
            do {
                let snapshot = try await Self.fetch(page, client: client)
                guard !Task.isCancelled else { return }
                self?.snapshot = snapshot
            } catch {
                guard !Task.isCancelled else { return }
                self?.failed = true
            }
            self?.reload()
        }
    }

    private nonisolated static func fetch(_ page: Page, client: AgentClient) async throws -> Snapshot {
        switch page {
        case .zones:
            let zones = try await client.cloudZones()
            let listed = zones.flatMap(\.members)
            let ids = Set(listed.filter { $0.kind == .user }.map(\.id)).sorted()
            var names: [String: String] = [:]
            for start in stride(from: 0, to: ids.count, by: 100) {
                try Task.checkCancellation()
                let users = try? await client.teamUsers(Array(ids[start..<min(start + 100, ids.count)]))
                for user in users ?? [] where !user.name.isEmpty { names[user.id] = user.name }
            }
            var teams: [String: String] = [:]
            if listed.contains(where: { $0.kind == .team }), let read = try? await client.teams() {
                teams = Dictionary(read.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
            }
            return .zones(zones, names: names, teams: teams)
        case .secrets:
            return .secrets(try await client.cloudSecretMetadata())
        }
    }

    override func makeRows() -> [[SettingsRow]] {
        typealias Text = Strings.CloudMetadata
        if failed {
            return [[SettingsRow(id: "retry", title: Text.failed, accessory: .none, subtitle: Text.retry, action: { [weak self] in self?.refresh() })]]
        }
        switch snapshot {
        case nil:
            return [[SettingsRow(id: "loading", title: Text.loading, accessory: .none)]]
        case .zones(let zones, let names, let teams):
            var rows = zones.map { zone in
                let access = !zone.restricted ? Text.allMembers : zone.members.isEmpty ? Text.noMembers
                    : ListFormatter.localizedString(byJoining: zone.members.map { ($0.kind == .user ? names[$0.id] : teams[$0.id]) ?? $0.id })
                let settings = [zone.internet.map(Text.internet), zone.compute.map(Text.compute)].compactMap { $0 }.joined(separator: " · ")
                let subtitle = [zone.restricted ? Text.restricted : nil, zone.description.isEmpty ? nil : zone.description,
                                Text.mayJoin(access), settings.isEmpty ? nil : settings]
                    .compactMap { $0 }.joined(separator: "\n")
                return SettingsRow(id: "zone-\(zone.id)", title: zone.name, icon: ("shield-checkmark-outline", Self.tile(zone.color)),
                                   accessory: .none, subtitle: subtitle, subtitleLines: 0)
            }
            if rows.isEmpty { rows = [SettingsRow(id: "no-zones", title: Text.noZones, accessory: .none)] }
            rows[rows.count - 1].footer = Text.manageOnDesktop
            return [rows]
        case .secrets(let secrets):
            if secrets.isEmpty { return [[SettingsRow(id: "no-secrets", title: Text.noSecrets, accessory: .none)]] }
            let groups = Dictionary(grouping: secrets) { ["team", "me", "agent"].contains($0.owner ?? "") ? $0.owner : nil }
            return ["team", "me", "agent", nil].compactMap { owner in
                guard let group = groups[owner] else { return nil }
                var rows = group.map { secret in
                    SettingsRow(id: "secret-\(secret.id)", title: secret.name, icon: ("key-outline", .indigo), accessory: .none,
                                subtitle: secret.description.flatMap { $0.isEmpty ? nil : $0 }, subtitleLines: 0)
                }
                rows[0].header = Text.owner(owner)
                return rows
            }
        }
    }

    private static func tile(_ color: String) -> SettingsRow.Tile {
        let hex: String
        switch color {
        case "red": hex = "#DC2626"
        case "orange": hex = "#EA580C"
        case "amber": hex = "#B45309"
        case "green": hex = "#15803D"
        case "teal": hex = "#0F766E"
        case "blue": hex = "#2563EB"
        case "indigo": hex = "#4F46E5"
        case "purple": hex = "#9333EA"
        case "pink": hex = "#DB2777"
        default: hex = "#6B7280"
        }
        guard let rgba = RGBA(hex: hex) else { return .gray }
        return .custom(ColorToken(light: rgba, dark: rgba))
    }
}
#endif
