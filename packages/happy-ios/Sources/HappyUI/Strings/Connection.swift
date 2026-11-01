import Foundation
import HappyCore

extension Strings {
    /// Settings › Connection: how the account reaches its server or
    /// computer, and what went over it in the last ten minutes. A
    /// diagnostics page, in English as Data and Storage is; the link's
    /// state is the headers' own words (`HeaderStatus`).
    enum Connection {
        static let title = "Connection"
        static let status = "Status"
        static let lastTenMinutes = "Last 10 Minutes"
        static let byChannel = "By Channel"
        static let tailcat = "Tailcat"

        static let type = "Type"
        static let state = "State"
        static let computer = "Computer"
        static let node = "Node"
        static let port = "Port"
        static let relay = "Relay"
        static let path = "Path"
        static let server = "Server"
        static let realtime = "Realtime"
        static let connectedFor = "Connected"
        static let network = "Network"

        static let sent = "Sent"
        static let received = "Received"
        static let requests = "Requests"
        static let connections = "Connections"
        static let webSockets = "WebSockets"
        static let eventStreams = "Event streams"
        static let latency = "Request time"
        static let bytesPerMinute = "Bytes per minute"

        static let liveFlows = "Live flows"
        static let tunnels = "Tunnels open"
        static let lastError = "Last error"
        static let none = "None"
        static let notConnected = "Not connected"
        static let dash = "—"

        static let copy = "Copy Diagnostics"
        static let copied = "Copied"
        static let copyFooter = "A plain-text snapshot of this page, for a bug report. It holds no keys, tokens or addresses that would let anyone in."

        static let tailcatFooter = "Each request opens its own flow through the tunnel. This phone may have 1,024 open at once; the computer accepts 256 at once on its port from every phone together."
        static let httpConnectionsFooter = "The system keeps HTTP connections open to reuse them and closes them without saying, so only the ones it opened are counted."

        static func since(_ duration: String) -> String { "Counting for \(duration), since this account opened." }

        // The connection in plain words.
        static let tailcatConnecting = "Tailcat · connecting"
        static func tailcatRelayed(_ region: String) -> String { "Tailcat · relayed via \(region)" }
        static let tailcatDirect = "Tailcat · direct (peer to peer)"
        static let tailcatUp = "Tailcat"
        static let happyServer = "Happy CLI server · HTTPS + Socket.IO"
        static let happyServerPlain = "Happy CLI server · HTTP + Socket.IO"
        static let relayed = "Relayed (DERP)"
        static func direct(_ endpoint: String) -> String { "Direct · \(endpoint)" }

        static func requestsValue(_ count: String, failed: String?) -> String {
            failed.map { "\(count) · \($0) failed" } ?? count
        }
        static func openedClosed(_ opened: String, _ closed: String?) -> String {
            closed.map { "\(opened) opened · \($0) closed" } ?? "\(opened) opened"
        }
        static func streams(_ opened: String, _ closed: String, reconnects: String) -> String {
            "\(opened) opened · \(closed) closed · \(reconnects) reconnects"
        }
        static func latencyValue(p50: String, p95: String) -> String { "p50 \(p50) · p95 \(p95)" }
        static func peak(_ size: String) -> String { "peak \(size)" }
        static func flows(_ open: String) -> String { "\(open) of 1,024" }
        static func ago(_ error: String, _ age: String) -> String { "\(error), \(age) ago" }
    }
}
