import HappyCore

extension Strings {
    /// Native read-only Cloud monitoring; no shared mobile catalog yet.
    enum Compute {
        static let title = "Compute"
        static let loading = "Loading…"
        static let unknown = "Unknown"
        static let emptyPools = "No compute pools"
        static let emptyNodes = "No machines"
        static let emptyPlacements = "No active sandboxes"
        static let denied = "You no longer have permission to view compute pools."
        static let missing = "This pool or machine is no longer available."
        static let failed = "Couldn’t refresh. Tap to retry."
        static let stale = "Showing the last reading."
        static let capacityNote = "Configured slots across non-revoked machines, including offline and draining machines. Not available capacity."
        static let hostNote = "Startup host totals, not current usage or sandbox limits. Disk is the total workspace volume size."
        static let placementNote = "Durable sandbox placements, including idle and reserved sandboxes."
        static let cpu = "Logical CPU cores"
        static let memory = "Physical RAM"
        static let disk = "Workspace volume"
        static let lastSeen = "Last seen"
        static let version = "Supervisor version"
        static let operatingSystem = "Operating system"
        static let backend = "Backend"
        static let capacity = "Sandbox capacity"
        static func capacity(_ value: ComputeCapacity) -> String {
            value.total.map { "\(value.used) / \($0) sandboxes" } ?? "\(value.used) sandboxes"
        }
        static func revoked(_ count: Int) -> String { "\(count) revoked" }
        static func counts(_ value: ComputePool.Counts) -> String {
            "\(value.online) online · \(value.offline) offline · \(value.draining) draining · \(value.enrolling) enrolling"
        }
    }
}