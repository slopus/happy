import Foundation

/// The phone's drawer (Steve, iPhone and Android alike): Home, then home's
/// places, the Surfaces the person is in under a divider, and Settings at
/// its foot. Home on a phone is then only the bots and tasks. Both are cut
/// from the rows `SidebarRows.make` draws, so they keep its order.
public enum Drawer {
    /// The places' kinds, in the drawer's order (Android's too): a Happy
    /// Cloud server's Plugins and Pipelines after the person's own.
    public static let placeKinds = ["feed", "artifacts", "documents", "todos", "plugins", "pipelines"]
    public static let homeId = "drawer:home"
    public static let settingsId = "drawer:settings"
    public static let surfacesId = "drawer:surfaces"

    /// Home's own row, first in the drawer.
    public static func homeRow(label: String) -> Row {
        Row(id: homeId, nodeId: homeId, kind: .space, label: label, mark: .glyph("home"), targetKind: "home")
    }

    /// The row at the drawer's foot.
    public static func settingsRow(label: String) -> Row {
        Row(id: settingsId, nodeId: settingsId, kind: .space, label: label, mark: .glyph("settings-outline"), targetKind: "settings")
    }

    /// Home, the places, then a divider and the other Surfaces the person
    /// is in, in home's order. The shared bot stays on home.
    public static func items(_ rows: [Row], home: Row) -> [Row] {
        let top = rows.filter { $0.depth == 0 && $0.kind == .space }
        let places = placeKinds.compactMap { kind in top.first { $0.targetKind == kind } }
        let surfaces = top.filter { $0.targetKind == "surface" }
        let divider = surfaces.isEmpty ? [] : [Row(id: surfacesId, nodeId: surfacesId, kind: .separator, label: "")]
        return [home] + places + divider + surfaces
    }

    /// Home on a phone: what is left once the drawer's places, the other
    /// Surfaces and the projects (each with what nests under it) are taken
    /// out: the shared bot, the bots and the tasks, each group parted from
    /// the one before. Search still finds what went.
    public static func home(_ rows: [Row]) -> [Row] {
        let drawn = Set(placeKinds + ["surface", "project", "workspace"])
        var kept: [Row] = []
        var keeping = true
        for row in rows {
            if row.kind == .separator, row.depth == 0 {
                keeping = true
                // A divider only between two groups that have rows.
                if let last = kept.last, last.kind != .separator { kept.append(row) }
                continue
            }
            if row.depth == 0 { keeping = !drawn.contains(row.targetKind ?? "") }
            if keeping { kept.append(row) }
        }
        if kept.last?.kind == .separator { kept.removeLast() }
        return kept
    }
}
